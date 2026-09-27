/**
 * Layer 5 — LIVE smoke test against real provider APIs (not part of `npm test`).
 *
 *   node __tests__/live/connectors.live.js
 *
 * Uses the PRODUCTION connectors and the PRODUCTION SSRF-safe client (no
 * test seams: real DNS, TLS, public-address checks). Without credentials it
 * performs unauthenticated public reads of github.com/octocat/Hello-World.
 * With GITHUB_TEST_TOKEN set it also runs the authenticated health check
 * (GET /user). It never writes anything and never prints tokens.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { createSafeHttpClient } = require(path.join(__dirname, '..', '..', 'services', 'integrations', 'safeHttp.js'));
const { createGithubConnector } = require(path.join(__dirname, '..', '..', 'services', 'integrations', 'connectors', 'githubConnector.js'));
const { createHttpApiConnector } = require(path.join(__dirname, '..', '..', 'services', 'integrations', 'connectors', 'httpApiConnector.js'));

async function main() {
  const http = createSafeHttpClient();
  const gh = createGithubConnector();
  const config = gh.validateConfig({ allowedRepos: ['octocat/hello-world'] });
  const token = process.env.GITHUB_TEST_TOKEN ? gh.validateCredential({ token: process.env.GITHUB_TEST_TOKEN }) : null;
  const results = [];
  const run = async (action, input) => {
    const v = gh.validateAction(action, input, config);
    const out = await gh.execute({ action, input: v, config, credential: token, http });
    results.push({ action, summary: out.summary, verified: out.verified });
    return out;
  };
  const repo = await run('get_repository', { owner: 'octocat', repo: 'Hello-World' });
  assert.strictEqual(repo.data.full_name, 'octocat/Hello-World');
  const issues = await run('list_issues', { owner: 'octocat', repo: 'Hello-World', limit: 5 });
  assert.ok(issues.data.items.every((i) => Number.isInteger(i.number)));
  const prs = await run('list_pull_requests', { owner: 'octocat', repo: 'Hello-World', limit: 5, state: 'all' });
  assert.ok(Array.isArray(prs.data.items));
  const file = await run('read_file', { owner: 'octocat', repo: 'Hello-World', path: 'README' });
  assert.match(file.data.content, /Hello World/i);
  assert.throws(() => gh.validateAction('list_issues', { owner: 'torvalds', repo: 'linux' }, config), /allowlist/);
  if (token) {
    const h = await gh.healthCheck({ config, credential: token, http });
    results.push({ action: 'healthCheck', summary: h.ok ? 'authenticated' : 'failed', verified: h.ok });
  }

  // Generic HTTP connector, production validation, real public HTTPS API.
  const hc = createHttpApiConnector();
  const hcfg = hc.validateConfig({ baseUrl: 'https://api.github.com/', allowedPathPrefixes: ['/repos/octocat/'], authType: 'none' });
  const hin = hc.validateAction('get', { path: '/repos/octocat/Hello-World' }, hcfg);
  const hout = await hc.execute({ action: 'get', input: hin, config: hcfg, credential: null, http });
  assert.strictEqual(hout.data.status, 200);
  assert.strictEqual(hout.data.data.full_name, 'octocat/Hello-World');
  results.push({ action: 'http.get', summary: hout.summary, verified: hout.verified });

  // SSRF: the production client refuses internal destinations for real.
  for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://localhost/', 'https://[::1]/']) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    await assert.rejects(http.request({ url, allowedHosts: [host] }), (e) => e.code === 'BLOCKED_DESTINATION', url);
  }
  results.push({ action: 'ssrf', summary: 'internal destinations refused', verified: true });

  for (const r of results) console.log(`LIVE OK: ${r.action} — ${r.summary} (verified=${r.verified})`);
  console.log(`\n${results.length} live checks passed${token ? ' (authenticated)' : ' (unauthenticated public reads)'}`);
}

main().catch((err) => {
  console.error(`LIVE FAIL: ${err.code || err.name}: ${err.message}`);
  process.exit(1);
});
