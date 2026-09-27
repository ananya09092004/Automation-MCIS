#!/usr/bin/env node
/**
 * Layer 9 — secret scanner (repository, and optionally the database).
 *
 *   node scripts/secret-scan.js [--root <dir>] [--include-tests] [--db] [--json]
 *
 * Repository: every text file under --root (default: the repository root,
 * two levels up) except node_modules / build output / .git. Test files are
 * skipped unless --include-tests (they contain deliberately FAKE keys).
 * .env files are never read; their presence is reported so you can check
 * they are git-ignored.
 *
 * --db (needs SUPABASE_URL + SUPABASE_KEY): counts legacy plaintext GitHub
 * tokens, integration credentials without ciphertext, and scans the most
 * recent audit rows / execution step evidence for secret patterns.
 *
 * Output names the file, line and pattern — NEVER the matched value.
 * Exit code: 0 clean, 1 findings, 2 scan error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['stripe-secret-key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/],
  ['stripe-webhook-secret', /\bwhsec_[0-9A-Za-z+/=]{24,}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b|\bgithub_pat_[0-9A-Za-z_]{60,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['google-oauth-token', /\bya29\.[0-9A-Za-z_-]{20,}\b/],
  ['slack-token', /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/],
  ['nexus-api-key', /\bnxk_[0-9A-Za-z]{6,}_[0-9A-Za-z_-]{20,}\b/],
  ['groq-key', /\bgsk_[0-9A-Za-z]{40,}\b/],
  ['openai-key', /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/],
  ['service-role-jwt', /\beyJ[0-9A-Za-z_-]{10,}\.(eyJ[0-9A-Za-z_-]{10,})\.[0-9A-Za-z_-]{10,}\b/, (m) => {
    try { return /"role"\s*:\s*"service_role"/.test(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return false; }
  }],
  ['firebase-private-key-json', /"private_key"\s*:\s*"-----BEGIN/],
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'coverage', '.next', '__pycache__', '.venv', 'venv', '.pytest_cache']);
const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|py|sql|md|txt|yml|yaml|toml|ini|cfg|html|css|sh|ps1|bat|env\.example|example)$/i;
const MAX_FILE = 2 * 1024 * 1024;

function scanText(text, where, findings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, re, confirm] of PATTERNS) {
      const m = line.match(re);
      // Obvious placeholders ("gsk_xxxx…", "sk_test_0000…") are not secrets: skip low-variety values.
      if (m && m[0].length >= 20 && new Set(m[0].slice(4)).size < 6) continue;
      if (m && (!confirm || confirm(m))) findings.push({ where, line: i + 1, pattern: name });
    }
  });
}

function scanRepo(root, { includeTests = false } = {}) {
  const findings = [];
  const envFiles = [];
  let files = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (!includeTests && (e.name === '__tests__' || e.name === 'tests')) continue;
        walk(p);
      } else if (e.isFile()) {
        if (/^\.env(\..*)?$/.test(e.name) && !/\.example$/.test(e.name)) { envFiles.push(path.relative(root, p)); continue; }
        if (!TEXT_EXT.test(e.name) && e.name !== 'Dockerfile') continue;
        if (!includeTests && /\.(test|spec)\.[jt]sx?$|^test_.*\.py$/.test(e.name)) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.size > MAX_FILE) continue;
        files += 1;
        scanText(fs.readFileSync(p, 'utf8'), path.relative(root, p), findings);
      }
    }
  };
  walk(root);
  let gitignoreCoversEnv = null;
  try {
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    gitignoreCoversEnv = /^\s*(\*\*\/)?\.env(\*|\b)/m.test(gi);
  } catch { gitignoreCoversEnv = null; }
  return { files, findings, envFiles, gitignoreCoversEnv };
}

async function scanDb(db, { auditRows = 2000, evidenceRows = 2000 } = {}) {
  const out = { checks: [], findings: [] };
  const count = async (label, q) => {
    const { count: n, error } = await q;
    out.checks.push({ check: label, count: error ? null : n || 0, error: error ? (error.code || 'error') : null });
  };
  await count('user_integrations.github_token (legacy plaintext) not null',
    db.from('user_integrations').select('user_id', { count: 'exact', head: true }).not('github_token', 'is', null));
  await count('integration_credentials without ciphertext',
    db.from('integration_credentials').select('integration_id', { count: 'exact', head: true }).is('ciphertext', null));
  const scanRows = async (table, cols, n) => {
    const { data, error } = await db.from(table).select(cols).order('created_at', { ascending: false }).limit(n);
    if (error) { out.checks.push({ check: `${table} scan`, count: null, error: error.code || 'error' }); return; }
    const f = [];
    for (const r of data || []) scanText(JSON.stringify(r), `${table}:${r.id || '?'}`, f);
    out.findings.push(...f);
    out.checks.push({ check: `${table} rows scanned`, count: (data || []).length, error: null });
  };
  await scanRows('audit_log', 'id, payload, error', auditRows);
  await scanRows('agent_execution_steps', 'id, output, error_message', evidenceRows);
  return out;
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (f) => args.includes(f);
  const ri = args.indexOf('--root');
  const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(__dirname, '..', '..', '..'));
  const repo = scanRepo(root, { includeTests: flag('--include-tests') });
  let db = null;
  if (flag('--db')) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.error('--db needs SUPABASE_URL and SUPABASE_KEY'); return 2; }
    const { createClient } = require('@supabase/supabase-js');
    db = await scanDb(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY));
  }
  const dbProblems = db ? db.findings.length + db.checks.filter((c) => c.count > 0 && !/rows scanned/.test(c.check)).length : 0;
  const report = { root: path.basename(root), filesScanned: repo.files, findings: repo.findings, envFilesPresent: repo.envFiles, gitignoreCoversEnv: repo.gitignoreCoversEnv, db };
  if (flag('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Scanned ${repo.files} files under ${report.root}${flag('--include-tests') ? ' (including tests)' : ''}.`);
    for (const f of repo.findings) console.log(`  FINDING ${f.pattern}  ${f.where}:${f.line}`);
    if (repo.envFiles.length) console.log(`  .env files present (not read): ${repo.envFiles.join(', ')} — .gitignore covers .env: ${repo.gitignoreCoversEnv}`);
    if (db) {
      for (const c of db.checks) console.log(`  DB ${c.check}: ${c.error ? `error ${c.error}` : c.count}`);
      for (const f of db.findings) console.log(`  DB FINDING ${f.pattern}  ${f.where}`);
    }
    console.log(repo.findings.length || dbProblems ? 'Secret scan: FINDINGS (values not shown).' : 'Secret scan: clean.');
  }
  return repo.findings.length || dbProblems ? 1 : 0;
}

if (require.main === module) {
  main(process.argv).then((c) => process.exit(c)).catch((e) => { console.error(`secret scan error: ${e.message}`); process.exit(2); });
}

module.exports = { scanRepo, scanText, scanDb, PATTERNS };
