/**
 * Layer 6 — workspace security policy: schema, secure defaults and the
 * pure decision function.
 *
 * The policy is a server-side document stored per workspace
 * (workspace_security_policies). It is only ever read from the database
 * by workspace id — nothing a client sends is treated as policy.
 *
 * Decision = the MOST RESTRICTIVE outcome of every rule that applies.
 * Rules can only keep or RAISE the risk the lower layers computed
 * (Layer 3 riskModel tier, Layer 5 per-action permission tier); nothing
 * here can lower a tier. Order does not matter.
 *
 *   ALLOW              → run (Layer 3 may still ask for its own approvals,
 *                        e.g. a first-time resource grant)
 *   APPROVAL_REQUIRED  → Layer 3 approval gate (the ONLY approval system);
 *                        `requiredRole` admin ⇔ risk red
 *   DENY               → never executed; recorded as not-executed evidence
 *
 * Built-in rules that a workspace policy can NOT turn off:
 *   - credential extraction (ssh keys, cloud credential files, .env,
 *     browser cookie/login stores, keychains …) is denied
 *   - resources that name ANOTHER workspace are denied
 *   - cloud metadata endpoints are denied
 *   - tainted executions (external content showed injection signals)
 *     need approval for anything that is not read-only
 * Built-in rules that a policy CAN relax explicitly (deny by default):
 *   - dangerous desktop/browser actions: delete, terminal, process kill,
 *     software install, browser session export/import
 */
'use strict';

const path = require('path');

const RISK_RANK = { green: 0, yellow: 1, red: 2 };
const RISKS = ['green', 'yellow', 'red'];
const ROLE_RANK = { member: 1, admin: 2, owner: 3 };
const RULES = ['allow', 'approval', 'admin_approval', 'deny'];
const RULE_RISK = { allow: 'green', approval: 'yellow', admin_approval: 'red' };
const EXECUTION_TYPES = ['connector', 'browser', 'desktop'];
const DECISION = Object.freeze({ ALLOW: 'ALLOW', APPROVAL_REQUIRED: 'APPROVAL_REQUIRED', DENY: 'DENY' });
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Dangerous agent actions: DENY unless the policy sets them explicitly.
const DANGEROUS_ACTIONS = Object.freeze({
  run_terminal: 'deny', kill_process: 'deny', restart_process: 'deny', start_process: 'deny',
  install_software: 'deny', save_session: 'deny', load_session: 'deny',
});
const FILE_READ = new Set(['read_file', 'search_file', 'verify_path', 'list_folder', 'search_folder', 'open_path', 'reveal_file', 'open_file',
  'list_items', 'search_items', 'read_word_document', 'read_excel_rows', 'inspect_powerpoint_presentation', 'open_office_document']);
const FILE_WRITE = new Set(['create_file', 'write_file', 'edit_file', 'rename_file', 'copy_file', 'move_file', 'create_folder', 'rename_folder', 'copy_folder',
  'move_folder', 'create_word_document', 'create_excel_workbook', 'create_powerpoint_presentation', 'organize_downloads', 'download']);
const FILE_DELETE = new Set(['delete_file', 'delete_folder']);
// A local file that is SENT somewhere (browser upload) is checked as a read of a protected file.
const FILE_EXPORT = new Set(['upload']);

// Credential stores — never readable, writable or uploadable by an agent.
const CREDENTIAL_PATH_RES = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /(^|\/)\.aws\/(credentials|config)$/, /(^|\/)\.azure(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.kube\/config$/, /(^|\/)\.docker\/config\.json$/, /(^|\/)\.env(\.[a-z0-9_-]+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)$/, /(^|\/)\.git-credentials$/, /(^|\/)\.netrc$/, /(^|\/)_netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/,
  /(^|\/)\.gnupg(\/|$)/, /(^|\/)(login data|cookies|web data|local state)(-journal)?$/, /(^|\/)(key3|key4|logins)\.(db|json)$/,
  /keychain/, /(^|\/)microsoft\/(credentials|protect)(\/|$)/, /(^|\/)credentials\.json$/, /(^|\/)service[-_]?account[^/]*\.json$/,
  /(^|\/)secrets?\.(json|ya?ml|toml|env)$/, /(^|\/)wallet\.dat$/, /^\/etc\/(shadow|gshadow|sudoers)$/, /(^|\/)\.bash_history$/, /(^|\/)\.zsh_history$/,
];
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata', '100.100.100.200', 'fd00:ec2::254']);

function defaultPolicy() {
  return {
    maxRisk: 'red',
    executionTypes: { connector: true, browser: true, desktop: true },
    integrations: { allowProviders: null, denyIntegrationIds: [] },
    connectorActions: {},
    agentActions: {},
    domains: { allow: [], deny: [] },
    repositories: { allow: [], deny: [] },
    files: { read: 'allow', write: 'allow', delete: 'deny', protectedPaths: [], roots: [] },
    sensitiveData: { blockSecretsInInput: true },
    approval: { ttlMinutes: 15, taintedRequiresApproval: true },
    minRole: { execute: 'member', stateChanging: 'member' },
    schedule: null,
    // Layer 9: workspace emergency stop — every agent / connector action is denied while true.
    emergencyStop: false,
  };
}

/** Layer 9: IANA time zone check (no dependency: Intl throws on unknown zones). */
function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Day of week (0 = Sunday) and hour in the given zone (UTC when none). */
function zonedDayHour(t, tz) {
  if (!tz || tz === 'UTC') return { day: t.getUTCDay(), hour: t.getUTCHours() };
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(t);
  const wd = parts.find((x) => x.type === 'weekday').value;
  const hour = Number(parts.find((x) => x.type === 'hour').value) % 24;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

class PolicyError extends Error {
  constructor(message) { super(message); this.name = 'PolicyError'; this.status = 400; this.code = 'INVALID_POLICY'; }
}
const bad = (m) => { throw new PolicyError(m); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function strList(v, field, { max = 100, re = null, maxLen = 200 } = {}) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max) bad(`${field} must be an array of at most ${max} strings`);
  return v.map((s, i) => {
    if (typeof s !== 'string' || !s.trim() || s.length > maxLen) bad(`${field}[${i}] must be a non-empty string (≤${maxLen})`);
    const t = s.trim().toLowerCase();
    if (re && !re.test(t)) bad(`${field}[${i}] has an invalid format`);
    return t;
  });
}
function onlyKeys(o, keys, field) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${field} has unknown field "${k}"`);
}
function rule(v, field) {
  if (!RULES.includes(v)) bad(`${field} must be one of ${RULES.join(', ')}`);
  return v;
}
function ruleMap(v, field, keyRe) {
  if (v === undefined) return undefined;
  if (!isObj(v) || Object.keys(v).length > 200) bad(`${field} must be an object (≤200 entries)`);
  const out = {};
  for (const [k, r] of Object.entries(v)) {
    if (!keyRe.test(k)) bad(`${field} has an invalid key "${k}"`);
    out[k] = rule(r, `${field}.${k}`);
  }
  return out;
}

const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
const REPO_RE = /^[a-z0-9_.-]{1,100}\/([a-z0-9_.-]{1,100}|\*)$/;

/** Strict validation of an owner-submitted policy. Unknown fields are rejected. */
function validatePolicy(input) {
  if (!isObj(input)) bad('policy must be an object');
  if (JSON.stringify(input).length > 60000) bad('policy is too large');
  onlyKeys(input, ['maxRisk', 'executionTypes', 'integrations', 'connectorActions', 'agentActions', 'domains', 'repositories', 'files', 'sensitiveData', 'approval', 'minRole', 'schedule', 'emergencyStop'], 'policy');
  const p = defaultPolicy();
  if (input.maxRisk !== undefined) { if (!RISKS.includes(input.maxRisk)) bad('maxRisk must be green, yellow or red'); p.maxRisk = input.maxRisk; }
  if (input.executionTypes !== undefined) {
    if (!isObj(input.executionTypes)) bad('executionTypes must be an object');
    onlyKeys(input.executionTypes, EXECUTION_TYPES, 'executionTypes');
    for (const [k, v] of Object.entries(input.executionTypes)) { if (typeof v !== 'boolean') bad(`executionTypes.${k} must be boolean`); p.executionTypes[k] = v; }
  }
  if (input.integrations !== undefined) {
    const i = input.integrations;
    if (!isObj(i)) bad('integrations must be an object');
    onlyKeys(i, ['allowProviders', 'denyIntegrationIds'], 'integrations');
    if (i.allowProviders !== undefined) p.integrations.allowProviders = i.allowProviders === null ? null : strList(i.allowProviders, 'integrations.allowProviders', { max: 50, re: /^[a-z][a-z0-9_]{1,31}$/ });
    if (i.denyIntegrationIds !== undefined) p.integrations.denyIntegrationIds = strList(i.denyIntegrationIds, 'integrations.denyIntegrationIds', { max: 200, re: /^[0-9a-f-]{36}$/ });
  }
  const ca = ruleMap(input.connectorActions, 'connectorActions', /^(\*|[a-z][a-z0-9_]{1,31}\.(\*|[a-z][a-z0-9_]{1,63}))$/);
  if (ca) p.connectorActions = ca;
  const aa = ruleMap(input.agentActions, 'agentActions', /^(\*|[a-z][a-z0-9_]{1,63})$/);
  if (aa) p.agentActions = aa;
  for (const [field, re] of [['domains', DOMAIN_RE], ['repositories', REPO_RE]]) {
    if (input[field] === undefined) continue;
    if (!isObj(input[field])) bad(`${field} must be an object`);
    onlyKeys(input[field], ['allow', 'deny'], field);
    p[field] = { allow: strList(input[field].allow, `${field}.allow`, { re }) || [], deny: strList(input[field].deny, `${field}.deny`, { re }) || [] };
  }
  if (input.files !== undefined) {
    const f = input.files;
    if (!isObj(f)) bad('files must be an object');
    onlyKeys(f, ['read', 'write', 'delete', 'protectedPaths', 'roots'], 'files');
    for (const k of ['read', 'write', 'delete']) if (f[k] !== undefined) p.files[k] = rule(f[k], `files.${k}`);
    if (f.protectedPaths !== undefined) p.files.protectedPaths = strList(f.protectedPaths, 'files.protectedPaths', { max: 100, maxLen: 500 }).map(normPath);
    if (f.roots !== undefined) p.files.roots = strList(f.roots, 'files.roots', { max: 50, maxLen: 500 }).map(normPath);
  }
  if (input.sensitiveData !== undefined) {
    if (!isObj(input.sensitiveData)) bad('sensitiveData must be an object');
    onlyKeys(input.sensitiveData, ['blockSecretsInInput'], 'sensitiveData');
    if (input.sensitiveData.blockSecretsInInput !== undefined) {
      if (typeof input.sensitiveData.blockSecretsInInput !== 'boolean') bad('sensitiveData.blockSecretsInInput must be boolean');
      p.sensitiveData.blockSecretsInInput = input.sensitiveData.blockSecretsInInput;
    }
  }
  if (input.approval !== undefined) {
    const a = input.approval;
    if (!isObj(a)) bad('approval must be an object');
    onlyKeys(a, ['ttlMinutes', 'taintedRequiresApproval'], 'approval');
    if (a.ttlMinutes !== undefined) { if (!Number.isInteger(a.ttlMinutes) || a.ttlMinutes < 1 || a.ttlMinutes > 60) bad('approval.ttlMinutes must be 1-60'); p.approval.ttlMinutes = a.ttlMinutes; }
    // Tainted executions ALWAYS need approval for writes (built-in); this flag can only be true.
    if (a.taintedRequiresApproval !== undefined && a.taintedRequiresApproval !== true) bad('approval.taintedRequiresApproval cannot be disabled');
  }
  if (input.minRole !== undefined) {
    if (!isObj(input.minRole)) bad('minRole must be an object');
    onlyKeys(input.minRole, ['execute', 'stateChanging'], 'minRole');
    for (const [k, v] of Object.entries(input.minRole)) { if (!ROLE_RANK[v]) bad(`minRole.${k} must be member, admin or owner`); p.minRole[k] = v; }
  }
  if (input.schedule !== undefined && input.schedule !== null) {
    const s = input.schedule;
    if (!isObj(s)) bad('schedule must be an object or null');
    onlyKeys(s, ['daysUtc', 'startHourUtc', 'endHourUtc', 'timeZone'], 'schedule');
    if (s.timeZone !== undefined && s.timeZone !== null && !validTimeZone(s.timeZone)) bad('schedule.timeZone must be an IANA time zone such as Asia/Kolkata');
    const days = s.daysUtc === undefined ? [0, 1, 2, 3, 4, 5, 6] : s.daysUtc;
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad('schedule.daysUtc must be integers 0-6');
    const start = s.startHourUtc === undefined ? 0 : s.startHourUtc;
    const end = s.endHourUtc === undefined ? 24 : s.endHourUtc;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) bad('schedule hours must satisfy 0 <= startHourUtc < endHourUtc <= 24');
    p.schedule = { daysUtc: [...new Set(days)].sort(), startHourUtc: start, endHourUtc: end };
    // Layer 9: days/hours are read in this zone when set (field names kept for compatibility).
    if (s.timeZone) p.schedule.timeZone = s.timeZone;
  }
  if (input.emergencyStop !== undefined) {
    if (typeof input.emergencyStop !== 'boolean') bad('emergencyStop must be boolean');
    p.emergencyStop = input.emergencyStop;
  }
  return p;
}

/** A stored policy is re-validated on read; a corrupt one throws (callers fail closed). */
function effectivePolicy(stored) {
  return stored ? validatePolicy(stored) : defaultPolicy();
}

function normPath(p) {
  let s = String(p).replace(/\\/g, '/').trim().toLowerCase();
  s = s.replace(/^file:\/\/+/, '/');
  const drive = /^[a-z]:/.test(s) ? s.slice(0, 2) : '';
  const rest = path.posix.normalize(drive ? s.slice(2) || '/' : s);
  return `${drive}${rest}`.replace(/\/+$/, '') || '/';
}
function pathTraverses(p) {
  return /(^|[\\/])\.\.([\\/]|$)/.test(String(p)) && normPath(p).split('/').includes('..');
}
function underRoot(p, root) {
  return p === root || p.startsWith(`${root}/`);
}
function matchesProtected(p, pattern) {
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(p);
  }
  return underRoot(p, pattern) || p.endsWith(`/${pattern}`) || p === pattern;
}
function hostMatches(host, pattern) {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern || host.endsWith(`.${pattern}`);
}
function repoMatches(repo, pattern) {
  const [o, r] = pattern.split('/');
  const [ro, rr] = repo.split('/');
  return o === ro && (r === '*' || r === rr);
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}
function mostRestrictiveRule(rules) {
  return rules.reduce((acc, r) => (RULES.indexOf(r) > RULES.indexOf(acc) ? r : acc), 'allow');
}
function lookup(map, keys) {
  for (const k of keys) if (map && Object.prototype.hasOwnProperty.call(map, k)) return map[k];
  return undefined;
}

/** Every string in `value` naming a workspace other than `ws`? */
function namesOtherWorkspace(value, ws, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    if (!/workspace/i.test(value) && !/^[0-9a-f-]{36}$/i.test(value)) return false;
    const m = value.match(/workspaces?[/:=_-]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return !!(m && m[1].toLowerCase() !== String(ws).toLowerCase());
  }
  if (Array.isArray(value)) return value.some((v) => namesOtherWorkspace(v, ws, depth + 1));
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^workspace[_-]?id$/i.test(k) && typeof v === 'string' && v.toLowerCase() !== String(ws).toLowerCase()) return true;
      if (namesOtherWorkspace(v, ws, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Pure decision. `req`:
 *   { workspaceId, role, executionType: connector|browser|desktop, action, provider?, integrationId?,
 *     baseRisk: green|yellow|red, readOnly: bool, resource: { url?, host?, repo?, path?, paths? },
 *     input, tainted: bool, inputSecretKinds: [], now: Date }
 * `policy` is an effective (validated) policy.
 */
function decide(req, policy, meta = {}) {
  const reasons = [];
  let risk = RISKS.includes(req.baseRisk) ? req.baseRisk : 'red'; // unknown → most restrictive
  let deny = false;
  const raise = (to, why) => { if (RISK_RANK[to] > RISK_RANK[risk]) risk = to; if (why) reasons.push(why); };
  const denyWith = (why) => { deny = true; reasons.push(why); };
  const applyRule = (r, why) => {
    if (r === 'deny') denyWith(why);
    else if (r && r !== 'allow') raise(RULE_RISK[r], why);
  };
  const type = req.executionType;
  const action = String(req.action || '');
  const readOnly = !!req.readOnly;
  const res = req.resource || {};

  // --- built-in, not relaxable ------------------------------------------
  if (policy.emergencyStop === true) denyWith('WORKSPACE_EMERGENCY_STOP'); // Layer 9: stops everything, read-only included
  if (!EXECUTION_TYPES.includes(type)) denyWith('UNKNOWN_EXECUTION_TYPE');
  if (namesOtherWorkspace(req.input, req.workspaceId) || namesOtherWorkspace(res, req.workspaceId)) denyWith('CROSS_WORKSPACE_RESOURCE');
  const paths = [...(res.paths || []), ...(res.path ? [res.path] : [])].filter((x) => typeof x === 'string' && x);
  for (const raw of paths) {
    if (pathTraverses(raw)) { denyWith('PATH_TRAVERSAL'); continue; }
    const p = normPath(raw);
    if (CREDENTIAL_PATH_RES.some((re) => re.test(p))) denyWith('CREDENTIAL_EXTRACTION_BLOCKED');
  }
  const host = res.host ? String(res.host).toLowerCase() : (res.url ? hostOf(res.url) : null);
  if (host && METADATA_HOSTS.has(host)) denyWith('METADATA_ENDPOINT_BLOCKED');
  if (req.tainted && !readOnly) raise('yellow', 'TAINTED_BY_EXTERNAL_CONTENT');

  // --- workspace policy -------------------------------------------------
  if (type && policy.executionTypes[type] === false) denyWith(`EXECUTION_TYPE_DISABLED:${type}`);
  if (!ROLE_RANK[req.role]) denyWith('NOT_A_MEMBER');
  else {
    if (ROLE_RANK[req.role] < ROLE_RANK[policy.minRole.execute]) denyWith(`ROLE_BELOW_MINIMUM:${policy.minRole.execute}`);
    if (!readOnly && ROLE_RANK[req.role] < ROLE_RANK[policy.minRole.stateChanging]) denyWith(`ROLE_BELOW_MINIMUM:${policy.minRole.stateChanging}`);
  }
  if (type === 'connector') {
    const prov = String(req.provider || '');
    if (policy.integrations.allowProviders && !policy.integrations.allowProviders.includes(prov)) denyWith('PROVIDER_NOT_ALLOWED');
    if (req.integrationId && policy.integrations.denyIntegrationIds.includes(String(req.integrationId).toLowerCase())) denyWith('INTEGRATION_DENIED');
    const r = lookup(policy.connectorActions, [`${prov}.${action}`, `${prov}.*`, '*']);
    if (r) applyRule(r, `CONNECTOR_ACTION_RULE:${r}`);
  } else {
    const explicit = lookup(policy.agentActions, [action]);
    const wildcard = lookup(policy.agentActions, ['*']);
    const dangerous = DANGEROUS_ACTIONS[action];
    const agentRules = [];
    if (explicit) agentRules.push(explicit);
    else if (dangerous) agentRules.push(dangerous); // deny unless explicitly set
    if (wildcard) agentRules.push(wildcard);
    if (agentRules.length) {
      const r = mostRestrictiveRule(agentRules);
      if (r === 'deny' && !explicit && dangerous) denyWith('DANGEROUS_ACTION_DENIED_BY_DEFAULT');
      else applyRule(r, `AGENT_ACTION_RULE:${r}`);
    }
    if (dangerous && explicit && explicit !== 'deny') raise('red', 'DANGEROUS_ACTION'); // always admin approval
    const isFileOp = FILE_READ.has(action) || FILE_WRITE.has(action) || FILE_DELETE.has(action) || FILE_EXPORT.has(action);
    if (FILE_READ.has(action) || FILE_EXPORT.has(action)) applyRule(policy.files.read, `FILE_READ_RULE:${policy.files.read}`);
    if (FILE_WRITE.has(action)) applyRule(policy.files.write, `FILE_WRITE_RULE:${policy.files.write}`);
    if (FILE_DELETE.has(action)) {
      if (policy.files.delete === 'deny') denyWith('FILE_DELETE_DENIED');
      else { applyRule(policy.files.delete, `FILE_DELETE_RULE:${policy.files.delete}`); raise('red', 'DESTRUCTIVE_FILE_OPERATION'); }
    }
    if (isFileOp) {
      for (const raw of paths) {
        if (pathTraverses(raw)) continue;
        const p = normPath(raw);
        if (policy.files.protectedPaths.some((pat) => matchesProtected(p, pat))) denyWith('PROTECTED_PATH');
        if (policy.files.roots.length && !policy.files.roots.some((root) => underRoot(p, root))) denyWith('OUTSIDE_ALLOWED_FILE_ROOTS');
      }
      if (FILE_EXPORT.has(action)) raise('red', 'LOCAL_FILE_EXPORT');
    }
  }
  if (host) {
    if (policy.domains.deny.some((d) => hostMatches(host, d))) denyWith('DOMAIN_DENIED');
    if (policy.domains.allow.length && !policy.domains.allow.some((d) => hostMatches(host, d))) denyWith('DOMAIN_NOT_ALLOWED');
  }
  if (res.repo) {
    const repo = String(res.repo).toLowerCase();
    if (policy.repositories.deny.some((r) => repoMatches(repo, r))) denyWith('REPOSITORY_DENIED');
    if (policy.repositories.allow.length && !policy.repositories.allow.some((r) => repoMatches(repo, r))) denyWith('REPOSITORY_NOT_ALLOWED');
  }
  if (policy.sensitiveData.blockSecretsInInput && (req.inputSecretKinds || []).length) {
    if (type === 'connector' && !readOnly) denyWith('SENSITIVE_DATA_IN_INPUT');
    else raise('red', 'SENSITIVE_DATA_IN_INPUT');
  }
  if (policy.schedule && !readOnly) {
    const t = req.now instanceof Date ? req.now : new Date();
    const { day, hour: h } = zonedDayHour(t, policy.schedule.timeZone);
    if (!policy.schedule.daysUtc.includes(day) || h < policy.schedule.startHourUtc || h >= policy.schedule.endHourUtc) denyWith('OUTSIDE_ALLOWED_HOURS');
  }
  if (RISK_RANK[risk] > RISK_RANK[policy.maxRisk]) denyWith(`EXCEEDS_MAX_RISK:${policy.maxRisk}`);

  const decision = deny ? DECISION.DENY : (risk === 'green' ? DECISION.ALLOW : DECISION.APPROVAL_REQUIRED);
  return {
    decision,
    risk,
    reasons: [...new Set(reasons)].slice(0, 20),
    policyId: meta.policyId || 'builtin-default',
    policyVersion: meta.policyVersion || 0,
    requiredRole: risk === 'red' ? 'admin' : 'member',
  };
}

module.exports = {
  decide, validatePolicy, effectivePolicy, defaultPolicy, normPath, hostOf, namesOtherWorkspace, zonedDayHour, validTimeZone,
  PolicyError, DECISION, RISK_RANK, ROLE_RANK, DANGEROUS_ACTIONS, FILE_READ, FILE_WRITE, FILE_DELETE, CREDENTIAL_PATH_RES,
};
