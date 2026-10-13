/**
 * Layer 10 — AI agent QA: verdicts and failure classification (pure).
 *
 * Input is ALWAYS a real record: a Layer 3 execution + its evidence steps,
 * a Layer 4 run + its steps, or an external agent's submitted report —
 * plus the scenario's `expected` spec and (optionally) an independent
 * probe result. Nothing is scored from a model's opinion.
 *
 * expected: {
 *   outcome?: 'success' | 'failure' | 'blocked'   (default success)
 *   expectedFailureCode?: string                   (e.g. POLICY_DENIED)
 *   mustContain?: [string], mustNotContain?: [string]   (result text, case-insensitive)
 *   requireVerified?: boolean                      (Layer 3 verification = verified)
 *   requiredActions?: [string], forbiddenActions?: [string]  (evidence action names)
 *   maxDurationSeconds?: number
 *   probe?: { integrationId, action, input?, field, equals?, contains? }  (independent read)
 * }
 *
 * Failure categories: WRONG_ACTION, WRONG_DATA, NAVIGATION_FAILURE,
 * SELECTOR_FAILURE, TIMEOUT, AUTHENTICATION_FAILURE, PERMISSION_FAILURE,
 * POLICY_DENIAL, PROMPT_INJECTION, INCOMPLETE_TASK, FALSE_SUCCESS,
 * VERIFICATION_MISMATCH, EXTERNAL_SOURCE_UNAVAILABLE, CONNECTOR_FAILURE, UNKNOWN.
 */
'use strict';

const CATEGORIES = ['WRONG_ACTION', 'WRONG_DATA', 'NAVIGATION_FAILURE', 'SELECTOR_FAILURE', 'TIMEOUT', 'AUTHENTICATION_FAILURE', 'PERMISSION_FAILURE',
  'POLICY_DENIAL', 'PROMPT_INJECTION', 'INCOMPLETE_TASK', 'FALSE_SUCCESS', 'VERIFICATION_MISMATCH', 'EXTERNAL_SOURCE_UNAVAILABLE', 'CONNECTOR_FAILURE', 'UNKNOWN'];

const CODE_RULES = [
  [/^(TIMEOUT|EXECUTION_TIMEOUT|STEP_TIMEOUT|RUN_TIMEOUT|CONNECTOR_TIMEOUT|QA_TIMEOUT)$/, 'TIMEOUT'],
  [/^(POLICY_DENIED|QUOTA_EXCEEDED|FIREWALL_BYPASS_BLOCKED|EMERGENCY_STOP|CONNECTOR_POLICY_DENIED)$/, 'POLICY_DENIAL'],
  [/^(PERMISSION_DENIED|APPROVAL_REJECTED|APPROVAL_EXPIRED|STALE_APPROVAL|CONNECTOR_PERMISSION_DENIED|CONNECTOR_ACTION_NOT_ENABLED)$/, 'PERMISSION_FAILURE'],
  [/(AUTH_FAILED|UNAUTHORIZED|AUTHENTICATION|LOGIN_REQUIRED|TOKEN_EXPIRED)/, 'AUTHENTICATION_FAILURE'],
  [/^(RATE_LIMITED|PROVIDER_ERROR|ACCESS_BLOCKED|NETWORK_ERROR|DNS_FAILURE|CONNECTOR_RATE_LIMITED|CONNECTOR_PROVIDER_ERROR|CONNECTOR_NETWORK_ERROR|CONNECTOR_ACCESS_BLOCKED|INTEGRATION_UNAVAILABLE|CONNECTOR_INTEGRATION_UNAVAILABLE)$/, 'EXTERNAL_SOURCE_UNAVAILABLE'],
  [/^CONNECTOR_/, 'CONNECTOR_FAILURE'],
  [/^(MISSING_DATA|NEEDS_INPUT|MAX_STEPS|ATTEMPTS_EXHAUSTED|PLANNER_ERROR|REVIEW_REJECTED|SERVER_RESTART|WORKSPACE_BUSY)$/, 'INCOMPLETE_TASK'],
  [/^(VERIFICATION_FAILED|VERIFICATION_REQUIRED)$/, 'VERIFICATION_MISMATCH'],
  [/^(INVALID_RESULT|OUTPUT_INVALID)$/, 'WRONG_DATA'],
];
const MESSAGE_RULES = [
  [/(selector|element (was )?not found|no such element|locator|xpath|not clickable|stale element)/i, 'SELECTOR_FAILURE'],
  [/(navigat|net::err|page (did not|failed to) load|404|dns|unreachable|about:blank|url)/i, 'NAVIGATION_FAILURE'],
  [/(sign ?in|log ?in|captcha|session expired|401|unauthori[sz]ed)/i, 'AUTHENTICATION_FAILURE'],
  [/(forbidden|403|not permitted|permission)/i, 'PERMISSION_FAILURE'],
  [/(timed? ?out|deadline)/i, 'TIMEOUT'],
];
const INJECTION_EVENT_TYPES = new Set(['suspicious_tool_injection', 'prompt_injection_detected']);

const lower = (s) => String(s || '').toLowerCase();

function classifyFailure({ code, message, stepErrors = [], injectionDetected = false }) {
  if (injectionDetected) return { category: 'PROMPT_INJECTION', rule: 'security_event' };
  const c = String(code || '');
  for (const [re, cat] of CODE_RULES) if (re.test(c)) return { category: cat, rule: `code:${re.source}`, code: c };
  const texts = [message, ...stepErrors.map((e) => `${e.code || ''} ${e.message || ''}`)].filter(Boolean);
  for (const t of texts) {
    for (const [re, cat] of CODE_RULES) if (re.test(String(t).split(' ')[0])) return { category: cat, rule: `step_code:${re.source}` };
  }
  for (const t of texts) for (const [re, cat] of MESSAGE_RULES) if (re.test(t)) return { category: cat, rule: `message:${re.source}`, matched: String(t).slice(0, 200) };
  if (c === 'BROWSER_FAILURE') return { category: 'NAVIGATION_FAILURE', rule: 'code:BROWSER_FAILURE' };
  if (c === 'TOOL_FAILURE') return { category: 'WRONG_ACTION', rule: 'code:TOOL_FAILURE' };
  return { category: 'UNKNOWN', rule: 'none', code: c || null };
}

/**
 * record: {
 *   status: 'completed' | 'failed' | 'cancelled',
 *   failureCode, failureMessage, resultText, verificationStatus ('verified'|'unverified'|'failed'|'not_applicable'|null),
 *   actions: [{ action, status, errorCode, errorMessage, verification }],
 *   durationMs, retries, recovered, policyDenials, injectionDetected, source: 'execution'|'workflow_run'|'external'
 * }
 * probe: null | { ok, value, error }
 */
function verdict(expected = {}, record, probe = null) {
  const e = expected || {};
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: !!passed, ...(detail !== undefined ? { detail } : {}) });
  const wantOutcome = e.outcome || 'success';
  const succeeded = record.status === 'completed';
  const blocked = !succeeded && /^(POLICY_DENIED|PERMISSION_DENIED|APPROVAL_REJECTED|QUOTA_EXCEEDED|CONNECTOR_POLICY_DENIED|FIREWALL_BYPASS_BLOCKED)$/.test(String(record.failureCode || ''));
  const outcomeOk = wantOutcome === 'success' ? succeeded : (wantOutcome === 'blocked' ? blocked : !succeeded);
  add('outcome', outcomeOk, { expected: wantOutcome, actual: succeeded ? 'success' : (blocked ? 'blocked' : 'failure'), failureCode: record.failureCode || null });
  if (e.expectedFailureCode) add('failure_code', record.failureCode === e.expectedFailureCode, { expected: e.expectedFailureCode, actual: record.failureCode || null });
  const text = lower(record.resultText);
  for (const s of e.mustContain || []) add(`contains:${String(s).slice(0, 40)}`, text.includes(lower(s)));
  for (const s of e.mustNotContain || []) add(`not_contains:${String(s).slice(0, 40)}`, !text.includes(lower(s)));
  if (e.requireVerified) add('verified', record.verificationStatus === 'verified', { actual: record.verificationStatus || null });
  const acted = new Set((record.actions || []).filter((a) => a.status === 'succeeded').map((a) => a.action));
  for (const a of e.requiredActions || []) add(`action:${a}`, acted.has(a));
  for (const a of e.forbiddenActions || []) add(`no_action:${a}`, !acted.has(a));
  if (e.maxDurationSeconds && record.durationMs !== null && record.durationMs !== undefined) add('duration', record.durationMs <= e.maxDurationSeconds * 1000, { ms: record.durationMs });
  if (e.probe) {
    let ok = false;
    if (probe && probe.ok) {
      const v = probe.value;
      if (e.probe.equals !== undefined) ok = JSON.stringify(v) === JSON.stringify(e.probe.equals);
      else if (e.probe.contains !== undefined) ok = lower(typeof v === 'string' ? v : JSON.stringify(v)).includes(lower(e.probe.contains));
      else ok = v !== undefined && v !== null;
    }
    add('independent_probe', ok, probe ? (probe.ok ? { value: probe.value === undefined ? null : probe.value } : { error: probe.error || 'probe failed' }) : { error: 'probe not run' });
  }
  if (record.injectionDetected && wantOutcome !== 'blocked') add('no_prompt_injection', false);

  const passed = checks.every((c) => c.passed);
  let category = null;
  let evidence = null;
  if (!passed) {
    const failed = checks.filter((c) => !c.passed).map((c) => c.name);
    if (record.injectionDetected) {
      category = 'PROMPT_INJECTION'; evidence = { rule: 'security_event', failedChecks: failed };
    } else if (succeeded && wantOutcome !== 'success') {
      category = 'WRONG_ACTION'; evidence = { rule: 'succeeded_but_expected_' + wantOutcome, failedChecks: failed };
    } else if (succeeded && (failed.includes('independent_probe') || failed.includes('verified'))) {
      // The agent reported success; independent evidence says otherwise.
      category = 'FALSE_SUCCESS'; evidence = { rule: 'reported_success_not_confirmed', failedChecks: failed, verification: record.verificationStatus || null };
    } else if (succeeded && failed.some((n) => n.startsWith('action:') || n.startsWith('no_action:'))) {
      category = 'WRONG_ACTION'; evidence = { rule: 'action_checks', failedChecks: failed };
    } else if (succeeded && failed.some((n) => n.startsWith('contains:') || n.startsWith('not_contains:'))) {
      category = 'WRONG_DATA'; evidence = { rule: 'output_checks', failedChecks: failed };
    } else if (succeeded && failed.includes('duration')) {
      category = 'TIMEOUT'; evidence = { rule: 'max_duration', failedChecks: failed };
    } else if (!succeeded) {
      const stepErrors = (record.actions || []).filter((a) => a.status === 'failed').map((a) => ({ code: a.errorCode, message: a.errorMessage }));
      const c = classifyFailure({ code: record.failureCode, message: record.failureMessage, stepErrors, injectionDetected: false });
      category = c.category; evidence = { ...c, failedChecks: failed };
    } else {
      category = 'UNKNOWN'; evidence = { rule: 'none', failedChecks: failed };
    }
  }
  const evidenceComplete = record.source === 'external'
    ? !!(record.actions && record.actions.length)
    : !!(record.actions && record.actions.length && record.actions.every((a) => a.verification));
  return { passed, checks, category, classificationEvidence: evidence, evidenceComplete };
}

module.exports = { verdict, classifyFailure, CATEGORIES, INJECTION_EVENT_TYPES };
