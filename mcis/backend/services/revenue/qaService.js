/**
 * Layer 10 — AI agent QA / reliability testing.
 *
 *   project (the agent under test)  → suites → scenarios
 *   run (a set of scenarios)        → one result per scenario
 *
 * Executors
 *   nexus_agent     a real Layer 3 execution (optionally as a named AI
 *                   workforce agent) — same firewall, approvals, evidence
 *   workflow        a real Layer 4 run of a published workflow
 *   external_agent  an agent outside Nexus reports what it did through the
 *                   automation API (qa:run scope); Nexus verifies it
 *
 * Verdicts come from real records only (qaVerifier): the execution / run
 * and its evidence, the scenario's expected spec, and optionally an
 * independent read-only probe through the connector gateway + firewall.
 *
 * The runner is lease-based (claim_qa_result, SKIP LOCKED) and never
 * blocks: an in-progress execution is re-checked when its short lease
 * expires. A scenario is started with a stable idempotency key
 * (qa:<resultId>), so a crashed worker never starts it twice, and is
 * metered once as an agent_test_scenario.
 */
'use strict';

const crypto = require('crypto');
const C = require('./common');
const { verdict, CATEGORIES } = require('./qaVerifier');

const EXECUTORS = ['nexus_agent', 'workflow', 'external_agent'];
const FINAL = new Set(['passed', 'failed', 'error', 'cancelled']);
const EXEC_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DENIAL_CODES = new Set(['POLICY_DENIED', 'CONNECTOR_POLICY_DENIED', 'FIREWALL_BYPASS_BLOCKED']);

function createQaService({
  store, executionService = null, execStore = null, workflowService = null, workflowStore = null, connectorActions = null,
  usage = null, events = null, workerHealth = null, appendAuditLog = null, logger = console, options = {},
} = {}) {
  if (!store) throw new Error('qa service: store is required');
  const now = options.now || (() => new Date());
  const iso = () => now().toISOString();
  const pollSeconds = options.pollSeconds || 5;
  const workerId = options.workerId || `qa_${crypto.randomBytes(6).toString('hex')}`;
  const emit = (type, payload) => (events ? events.emit(type, payload) : Promise.resolve());
  const audit = (actor, action, payload, ws) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(actor, action, payload, { success: true, error: null }, ws)).catch(() => {}); } catch { /* never */ }
  };

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  const projectView = (p) => ({ id: p.id, name: p.name, description: p.description, agentLabel: p.agent_label, agentId: p.agent_id, environment: p.environment, version: p.version, createdAt: p.created_at });
  const suiteView = (s) => ({ id: s.id, projectId: s.project_id, name: s.name, description: s.description, createdAt: s.created_at });
  const scenarioView = (s) => ({
    id: s.id, projectId: s.project_id, suiteId: s.suite_id, name: s.name, executor: s.executor, goal: s.goal, workflowId: s.workflow_id,
    inputs: s.inputs, expected: s.expected, timeoutSeconds: s.timeout_seconds, version: s.version, createdAt: s.created_at,
  });
  const resultView = (r) => ({
    id: r.id, runId: r.run_id, scenarioId: r.scenario_id, position: r.position, status: r.status, executionId: r.execution_id, workflowRunId: r.workflow_run_id,
    verdict: r.verdict, failureCategory: r.failure_category, classificationEvidence: r.classification_evidence, verified: r.verified,
    evidenceComplete: r.evidence_complete, durationMs: r.duration_ms, retries: r.retries, recovered: r.recovered, policyDenials: r.policy_denials,
    injectionDetections: r.injection_detections, startedAt: r.started_at, finishedAt: r.finished_at,
  });
  const runView = (r) => ({
    id: r.id, projectId: r.project_id, suiteId: r.suite_id, status: r.status, trigger: r.trigger, triggeredBy: r.triggered_by,
    scenarioCount: r.scenario_count, summary: r.summary, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at,
  });

  // ------------------------------------------------------------------
  // Projects / suites / scenarios
  // ------------------------------------------------------------------
  async function loadIn(table, ctx, id, what) {
    const ws = C.requireCtx(ctx);
    const r = await store.get(table, ws, C.uuidOr404(id, what));
    if (!r) throw C.notFound(what);
    return r;
  }

  async function createProject(ctx, body = {}) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'QA projects');
    C.onlyKeys(body, ['name', 'description', 'agentLabel', 'agentId', 'environment']);
    if (body.agentId !== undefined && body.agentId !== null && !(await store.get('workspace_agents', ws, C.uuidOr404(body.agentId, 'Agent')))) throw C.notFound('Agent');
    const env = body.environment === undefined ? {} : C.onlyKeys(body.environment, ['name', 'baseUrl', 'notes'], 'environment');
    const row = await store.insert('qa_projects', {
      workspace_id: ws, name: C.str(body.name, 'name', { max: 120 }), description: C.str(body.description, 'description', { max: 2000, optional: true }) || '',
      agent_label: C.str(body.agentLabel, 'agentLabel', { max: 120, optional: true }) || 'Nexus agent', agent_id: body.agentId || null,
      environment: { ...(env.name ? { name: C.str(env.name, 'environment.name', { max: 60 }) } : {}), ...(env.baseUrl ? { baseUrl: C.str(env.baseUrl, 'environment.baseUrl', { max: 300 }) } : {}), ...(env.notes ? { notes: C.str(env.notes, 'environment.notes', { max: 1000 }) } : {}) },
      created_by: ctx.userId,
    });
    return projectView(row);
  }
  async function listProjects(ctx) {
    const ws = C.requireCtx(ctx);
    return (await store.list('qa_projects', ws, { limit: 200 })).map(projectView);
  }
  async function getProject(ctx, id) {
    const p = await loadIn('qa_projects', ctx, id, 'QA project');
    const [suites, scenarios, runs] = await Promise.all([
      store.list('qa_suites', p.workspace_id, { filter: { project_id: p.id }, order: ['created_at', true], limit: 200 }),
      store.list('qa_scenarios', p.workspace_id, { filter: { project_id: p.id }, order: ['created_at', true], limit: 1000 }),
      store.list('qa_runs', p.workspace_id, { filter: { project_id: p.id }, limit: 20 }),
    ]);
    return { ...projectView(p), suites: suites.map(suiteView), scenarios: scenarios.map(scenarioView), recentRuns: runs.map(runView) };
  }
  async function deleteProject(ctx, id) {
    const p = await loadIn('qa_projects', ctx, id, 'QA project');
    C.requireAdmin(ctx, 'QA projects');
    const active = await store.count('qa_runs', p.workspace_id, { project_id: p.id, status: { in: ['queued', 'running'] } });
    if (active) throw C.conflict('Cancel the project\'s active runs first', 'QA_RUN_ACTIVE');
    await store.remove('qa_projects', p.workspace_id, p.id);
    return { deleted: true };
  }

  async function createSuite(ctx, projectId, body = {}) {
    const p = await loadIn('qa_projects', ctx, projectId, 'QA project');
    C.requireAdmin(ctx, 'QA suites');
    C.onlyKeys(body, ['name', 'description']);
    return suiteView(await store.insert('qa_suites', {
      workspace_id: p.workspace_id, project_id: p.id, name: C.str(body.name, 'name', { max: 120 }),
      description: C.str(body.description, 'description', { max: 2000, optional: true }) || '', created_by: ctx.userId,
    }));
  }

  function validateExpected(raw) {
    if (raw === undefined || raw === null) return {};
    const e = C.onlyKeys(raw, ['outcome', 'expectedFailureCode', 'mustContain', 'mustNotContain', 'requireVerified', 'requiredActions', 'forbiddenActions', 'maxDurationSeconds', 'probe'], 'expected');
    const out = {};
    if (e.outcome !== undefined) out.outcome = C.oneOf(e.outcome, 'expected.outcome', ['success', 'failure', 'blocked']);
    if (e.expectedFailureCode !== undefined) { if (typeof e.expectedFailureCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,59}$/.test(e.expectedFailureCode)) throw C.bad('expected.expectedFailureCode must be a code such as POLICY_DENIED'); out.expectedFailureCode = e.expectedFailureCode; }
    for (const k of ['mustContain', 'mustNotContain', 'requiredActions', 'forbiddenActions']) {
      if (e[k] === undefined) continue;
      if (!Array.isArray(e[k]) || e[k].length > 20 || e[k].some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) throw C.bad(`expected.${k} must list at most 20 short strings`);
      out[k] = e[k].map((x) => x.trim());
    }
    if (e.requireVerified !== undefined) { if (typeof e.requireVerified !== 'boolean') throw C.bad('expected.requireVerified must be boolean'); out.requireVerified = e.requireVerified; }
    if (e.maxDurationSeconds !== undefined) out.maxDurationSeconds = C.int(e.maxDurationSeconds, 'expected.maxDurationSeconds', { min: 1, max: 7200 });
    if (e.probe !== undefined) {
      const p = C.onlyKeys(e.probe, ['integrationId', 'action', 'input', 'field', 'equals', 'contains'], 'expected.probe');
      if (!C.isUuid(p.integrationId)) throw C.bad('expected.probe.integrationId is required');
      if (typeof p.action !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(p.action)) throw C.bad('expected.probe.action is invalid');
      if (p.input !== undefined && (typeof p.input !== 'object' || Array.isArray(p.input))) throw C.bad('expected.probe.input must be an object');
      if (typeof p.field !== 'string' || !/^\/[^\s]{0,200}$/.test(p.field)) throw C.bad('expected.probe.field must be a JSON Pointer into the result data, e.g. /data/status');
      out.probe = { integrationId: p.integrationId.toLowerCase(), action: p.action, input: p.input || {}, field: p.field, ...(p.equals !== undefined ? { equals: p.equals } : {}), ...(p.contains !== undefined ? { contains: String(p.contains).slice(0, 200) } : {}) };
    }
    if (JSON.stringify(out).length > 8000) throw C.bad('expected is too large');
    return out;
  }

  async function createScenario(ctx, suiteId, body = {}) {
    const s = await loadIn('qa_suites', ctx, suiteId, 'QA suite');
    C.requireAdmin(ctx, 'QA scenarios');
    C.onlyKeys(body, ['name', 'executor', 'goal', 'workflowId', 'inputs', 'expected', 'timeoutSeconds']);
    const executor = C.oneOf(body.executor, 'executor', EXECUTORS);
    let goal = null;
    let workflowId = null;
    if (executor === 'nexus_agent') goal = C.str(body.goal, 'goal', { max: 2000 });
    if (executor === 'external_agent') goal = C.str(body.goal, 'goal', { max: 2000, optional: true });
    if (executor === 'workflow') {
      workflowId = C.uuidOr404(body.workflowId, 'Workflow');
      if (!workflowService) throw new C.WorkspaceError(503, 'WORKFLOWS_UNAVAILABLE', 'Workflows are unavailable');
      await workflowService.getWorkflow(ctx, workflowId); // 404 outside this workspace
    }
    const inputs = body.inputs === undefined ? {} : body.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || JSON.stringify(inputs).length > 8000) throw C.bad('inputs must be an object');
    return scenarioView(await store.insert('qa_scenarios', {
      workspace_id: s.workspace_id, project_id: s.project_id, suite_id: s.id, name: C.str(body.name, 'name', { max: 200 }), executor, goal, workflow_id: workflowId,
      inputs, expected: validateExpected(body.expected), timeout_seconds: C.int(body.timeoutSeconds, 'timeoutSeconds', { min: 10, max: 7200, dflt: 600 }), created_by: ctx.userId,
    }));
  }

  async function deleteScenario(ctx, id) {
    const s = await loadIn('qa_scenarios', ctx, id, 'QA scenario');
    C.requireAdmin(ctx, 'QA scenarios');
    await store.remove('qa_scenarios', s.workspace_id, s.id);
    return { deleted: true };
  }

  // ------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------
  async function startRun(ctx, projectId, body = {}, { trigger = 'app' } = {}) {
    const p = await loadIn('qa_projects', ctx, projectId, 'QA project');
    C.onlyKeys(body, ['suiteId', 'scenarioIds', 'idempotencyKey']);
    const key = body.idempotencyKey === undefined || body.idempotencyKey === null ? null : body.idempotencyKey;
    if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key))) throw C.bad('idempotencyKey must be 8-128 characters of [A-Za-z0-9_.:-]');
    if (trigger === 'api' && !key) throw C.bad('API-triggered QA runs require an idempotency key');
    if (key) {
      const existing = await store.find('qa_runs', p.workspace_id, { idempotency_key: key });
      if (existing) {
        if (existing.project_id !== p.id) throw C.conflict('This idempotency key was already used for a different request.', 'IDEMPOTENCY_CONFLICT');
        return { run: runView(existing), replayed: true };
      }
    }
    const filter = { project_id: p.id };
    if (body.suiteId) filter.suite_id = C.uuidOr404(body.suiteId, 'QA suite');
    let scenarios = await store.list('qa_scenarios', p.workspace_id, { filter, order: ['created_at', true], limit: 1000 });
    if (body.scenarioIds !== undefined) {
      if (!Array.isArray(body.scenarioIds) || body.scenarioIds.length > 200) throw C.bad('scenarioIds must list at most 200 ids');
      const want = new Set(body.scenarioIds.map((x) => String(x).toLowerCase()));
      scenarios = scenarios.filter((s) => want.has(s.id));
      if (scenarios.length !== want.size) throw C.notFound('QA scenario');
    }
    if (!scenarios.length) throw C.bad('No scenarios to run');
    if (scenarios.length > 200) throw C.bad('A run may contain at most 200 scenarios');
    if (usage && usage.checkEntitlement) {
      const q = await usage.checkEntitlement(p.workspace_id, 'agent_test_scenarios', scenarios.length);
      if (!q.allowed) {
        if (q.reason === 'ENTITLEMENT_UNAVAILABLE') throw new C.WorkspaceError(503, 'ENTITLEMENT_UNAVAILABLE', 'Usage limits could not be verified; the run was not started.');
        throw new C.WorkspaceError(402, 'QUOTA_EXCEEDED', "Your plan's limit for agent test scenarios has been reached.");
      }
    }
    let run;
    try {
      run = await store.insert('qa_runs', {
        workspace_id: p.workspace_id, project_id: p.id, suite_id: filter.suite_id || null, status: 'running', trigger, triggered_by: ctx.userId,
        idempotency_key: key, scenario_count: scenarios.length, started_at: iso(),
      });
    } catch (err) {
      if (err.code === '23505' && key) return startRun(ctx, projectId, body, { trigger });
      throw err;
    }
    for (const [i, s] of scenarios.entries()) {
      await store.tryInsert('qa_results', {
        workspace_id: p.workspace_id, run_id: run.id, scenario_id: s.id, position: i, status: s.executor === 'external_agent' ? 'awaiting_submission' : 'pending',
      });
    }
    audit(ctx.userId, 'qa_run_started', { workspaceId: p.workspace_id, runId: run.id, projectId: p.id, scenarios: scenarios.length, trigger }, p.workspace_id);
    return { run: runView(run), replayed: false };
  }

  async function getRun(ctx, runId) {
    const r = await loadIn('qa_runs', ctx, runId, 'QA run');
    const results = await store.list('qa_results', r.workspace_id, { filter: { run_id: r.id }, order: ['position', true], limit: 500 });
    return { ...runView(r), results: results.map(resultView), report: report(results) };
  }

  async function listRuns(ctx, { projectId, limit } = {}) {
    const ws = C.requireCtx(ctx);
    const filter = projectId ? { project_id: C.uuidOr404(projectId, 'QA project') } : {};
    return (await store.list('qa_runs', ws, { filter, limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) })).map(runView);
  }

  async function cancelRun(ctx, runId) {
    const r = await loadIn('qa_runs', ctx, runId, 'QA run');
    if (!(C.hasRole(ctx.role, 'admin') || r.triggered_by === ctx.userId)) throw C.forbidden('Only the run\'s initiator or an admin can cancel it.');
    if (r.status === 'completed' || r.status === 'cancelled') return runView(r);
    const results = await store.list('qa_results', r.workspace_id, { filter: { run_id: r.id }, limit: 500 });
    for (const x of results) {
      if (FINAL.has(x.status)) continue;
      if (x.execution_id && executionService) await executionService.abortExecution(r.workspace_id, x.execution_id, { status: 'cancelled', code: 'CANCELLED', message: 'QA run cancelled.' }).catch(() => {});
      if (x.workflow_run_id && workflowService) await workflowService.cancelRun(ctx, x.workflow_run_id).catch(() => {});
      await store.update('qa_results', r.workspace_id, x.id, { status: 'cancelled', finished_at: iso(), lease_owner: null, lease_expires_at: null }, { expectVersion: x.version });
    }
    const u = await store.update('qa_runs', r.workspace_id, r.id, { status: 'cancelled', finished_at: iso(), summary: report(await store.list('qa_results', r.workspace_id, { filter: { run_id: r.id }, limit: 500 })) }, { expectVersion: r.version });
    audit(ctx.userId, 'qa_run_cancelled', { workspaceId: r.workspace_id, runId: r.id }, r.workspace_id);
    return runView(u || r);
  }

  // ------------------------------------------------------------------
  // Records → verdict
  // ------------------------------------------------------------------
  async function executionRecord(ws, execId) {
    const e = await execStore.getExecution(ws, execId);
    if (!e) return null;
    const steps = await execStore.listSteps(ws, execId);
    const actions = steps.map((s) => ({ action: s.action, status: s.status, errorCode: s.error_code, errorMessage: s.error_message, verification: s.verification ? s.verification.status : null }));
    const text = [e.result && e.result.message, ...steps.map((s) => s.output && s.output.message)].filter(Boolean).join('\n');
    const injection = steps.some((s) => /TAINTED|INJECTION/i.test(`${s.error_message || ''}`)) || /INJECTION/i.test(String(e.failure_message || ''));
    const denials = steps.filter((s) => DENIAL_CODES.has(s.error_code)).length || (DENIAL_CODES.has(e.failure_code) ? 1 : 0);
    const end = e.finished_at ? Date.parse(e.finished_at) : now().getTime();
    return {
      source: 'execution', status: e.status, active: !EXEC_TERMINAL.has(e.status), failureCode: e.failure_code, failureMessage: e.failure_message, resultText: text,
      verificationStatus: e.verification ? e.verification.status : null, actions, durationMs: Math.max(0, end - Date.parse(e.created_at)),
      retries: steps.reduce((a, s) => a + Math.max(0, (s.attempts || 1) - 1), 0), recovered: e.status === 'completed' && steps.some((s) => s.recovery || s.status === 'failed'),
      policyDenials: denials, injectionDetected: injection,
    };
  }

  async function workflowRecord(ws, runId) {
    const r = await workflowStore.getRun(ws, runId);
    if (!r) return null;
    const steps = await workflowStore.listRunSteps(ws, runId);
    const actions = steps.map((s) => ({ action: s.step_key, status: s.status === 'succeeded' ? 'succeeded' : (s.status === 'failed' ? 'failed' : s.status), errorCode: s.error_code, errorMessage: s.error_message, verification: s.verification ? s.verification.status : null }));
    const text = [r.result && r.result.lastOutput, ...steps.map((s) => s.output && s.output.message)].filter(Boolean).join('\n');
    const end = r.finished_at ? Date.parse(r.finished_at) : now().getTime();
    return {
      source: 'workflow_run', status: r.status, active: !RUN_TERMINAL.has(r.status), failureCode: r.failure_code, failureMessage: r.failure_message, resultText: text,
      verificationStatus: r.verification ? (r.verification.status === 'verified' ? 'verified' : r.verification.status) : null, actions,
      durationMs: Math.max(0, end - Date.parse(r.created_at)),
      retries: steps.reduce((a, s) => a + Math.max(0, (s.attempt || 1) - 1), 0), recovered: r.status === 'completed' && steps.some((s) => (s.attempt || 1) > 1),
      policyDenials: steps.filter((s) => DENIAL_CODES.has(s.error_code)).length, injectionDetected: steps.some((s) => s.output && s.output.tainted),
    };
  }

  async function runProbe(ws, actorId, probe, resultId) {
    if (!probe) return null;
    if (!connectorActions) return { ok: false, error: 'INTEGRATIONS_DISABLED' };
    const res = await connectorActions.run({ workspaceId: ws, actorId, integrationId: probe.integrationId, action: probe.action, input: probe.input || {}, sourceId: `qa-probe-${resultId}` });
    if (!res.ok) return { ok: false, error: res.code };
    const { pointer } = require('../monitoring/extract');
    return { ok: true, value: pointer(res.data, probe.field) };
  }

  async function finalize(result, scenario, run, record, { probe = null } = {}) {
    const ws = result.workspace_id;
    const v = verdict(scenario.expected, record, probe);
    const status = v.passed ? 'passed' : 'failed';
    const u = await store.update('qa_results', ws, result.id, {
      status, verdict: { passed: v.passed, checks: v.checks, source: record.source }, failure_category: v.category,
      classification_evidence: v.classificationEvidence, verified: record.verificationStatus === 'verified', evidence_complete: v.evidenceComplete,
      duration_ms: record.durationMs ?? null, retries: record.retries || 0, recovered: !!record.recovered, policy_denials: record.policyDenials || 0,
      injection_detections: record.injectionDetected ? 1 : 0, finished_at: iso(), lease_owner: null, lease_expires_at: null,
    }, { expectVersion: result.version });
    if (u) await maybeCompleteRun(ws, run.id);
    return u;
  }

  async function markError(result, run, code, message) {
    const u = await store.update('qa_results', result.workspace_id, result.id, {
      status: 'error', verdict: { passed: false, error: { code, message: String(message || code).slice(0, 300) } }, failure_category: null,
      finished_at: iso(), lease_owner: null, lease_expires_at: null,
    }, { expectVersion: result.version });
    if (u) await maybeCompleteRun(result.workspace_id, run.id);
    return u;
  }

  async function maybeCompleteRun(ws, runId) {
    const results = await store.list('qa_results', ws, { filter: { run_id: runId }, limit: 500 });
    if (!results.every((x) => FINAL.has(x.status))) return null;
    const run = await store.get('qa_runs', ws, runId);
    if (!run || run.status !== 'running') return null;
    const u = await store.update('qa_runs', ws, runId, { status: 'completed', finished_at: iso(), summary: report(results) }, { expectVersion: run.version });
    if (u) {
      audit(u.triggered_by, 'qa_run_completed', { workspaceId: ws, runId, passed: u.summary.passed, failed: u.summary.failed }, ws);
      await emit('qa_run.completed', { workspaceId: ws, run: runView(u) });
    }
    return u;
  }

  /** Metrics from stored results only. */
  function report(results) {
    const done = results.filter((r) => r.status === 'passed' || r.status === 'failed');
    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const byCategory = {};
    for (const r of results) if (r.failure_category) byCategory[r.failure_category] = (byCategory[r.failure_category] || 0) + 1;
    const durations = done.map((r) => r.duration_ms).filter((x) => Number.isFinite(x));
    const withRetries = done.filter((r) => r.retries > 0);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return {
      total: results.length, passed, failed,
      errored: results.filter((r) => r.status === 'error').length,
      cancelled: results.filter((r) => r.status === 'cancelled').length,
      pending: results.filter((r) => !FINAL.has(r.status)).length,
      passRate: pct(passed, passed + failed),
      failureCategories: byCategory,
      averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      verifiedRate: pct(done.filter((r) => r.verified).length, done.length),
      evidenceCompleteRate: pct(done.filter((r) => r.evidence_complete).length, done.length),
      averageRetries: done.length ? Math.round((done.reduce((a, r) => a + (r.retries || 0), 0) / done.length) * 100) / 100 : null,
      recoveryRate: pct(withRetries.filter((r) => r.recovered).length, withRetries.length),
      policyDenials: results.reduce((a, r) => a + (r.policy_denials || 0), 0),
      injectionDetections: results.reduce((a, r) => a + (r.injection_detections || 0), 0),
    };
  }

  async function projectMetrics(ctx, projectId, { runs: n } = {}) {
    const p = await loadIn('qa_projects', ctx, projectId, 'QA project');
    const runs = await store.list('qa_runs', p.workspace_id, { filter: { project_id: p.id, status: 'completed' }, limit: Math.min(Math.max(parseInt(n, 10) || 10, 1), 50) });
    const all = [];
    for (const r of runs) all.push(...(await store.list('qa_results', p.workspace_id, { filter: { run_id: r.id }, limit: 500 })));
    const byScenario = new Map();
    for (const r of all) {
      if (r.status !== 'passed' && r.status !== 'failed') continue;
      const e = byScenario.get(r.scenario_id) || { passed: 0, failed: 0 };
      e[r.status] += 1;
      byScenario.set(r.scenario_id, e);
    }
    const flaky = [...byScenario.entries()].filter(([, e]) => e.passed && e.failed).map(([scenarioId, e]) => ({ scenarioId, ...e }));
    return {
      project: projectView(p), runs: runs.length, overall: report(all), flakyScenarios: flaky,
      trend: runs.map((r) => ({ runId: r.id, finishedAt: r.finished_at, passRate: r.summary ? r.summary.passRate : null, total: r.summary ? r.summary.total : null })).reverse(),
      categories: CATEGORIES,
    };
  }

  // ------------------------------------------------------------------
  // External agent submissions
  // ------------------------------------------------------------------
  async function submitExternalResult(ctx, runId, resultId, body = {}) {
    const r = await loadIn('qa_runs', ctx, runId, 'QA run');
    const x = await store.get('qa_results', r.workspace_id, C.uuidOr404(resultId, 'QA result'));
    if (!x || x.run_id !== r.id) throw C.notFound('QA result');
    const scenario = await store.get('qa_scenarios', r.workspace_id, x.scenario_id);
    if (!scenario || scenario.executor !== 'external_agent') throw C.bad('This result is not for an external agent', 'NOT_EXTERNAL');
    if (x.status !== 'awaiting_submission') {
      if (FINAL.has(x.status)) return { replayed: true, result: resultView(x) };
      throw C.conflict('This result is not awaiting a submission', 'QA_RESULT_BUSY');
    }
    C.onlyKeys(body, ['status', 'output', 'actions', 'durationMs', 'failureCode', 'failureMessage', 'verificationStatus']);
    const status = C.oneOf(body.status, 'status', ['completed', 'failed']);
    const actions = body.actions === undefined ? [] : body.actions;
    if (!Array.isArray(actions) || actions.length > 200) throw C.bad('actions must list at most 200 actions');
    const cleanActions = actions.map((a) => {
      C.onlyKeys(a, ['action', 'status', 'errorCode', 'errorMessage', 'verification'], 'action');
      return {
        action: C.str(a.action, 'action.action', { max: 100 }), status: C.oneOf(a.status, 'action.status', ['succeeded', 'failed']),
        errorCode: a.errorCode ? C.str(a.errorCode, 'action.errorCode', { max: 80 }) : null, errorMessage: a.errorMessage ? C.str(a.errorMessage, 'action.errorMessage', { max: 300 }) : null,
        verification: a.verification ? C.oneOf(a.verification, 'action.verification', ['verified', 'unverified', 'failed', 'not_applicable']) : null,
      };
    });
    let handle = null;
    if (usage) {
      try { handle = await usage.begin(r.workspace_id, 'agent_test_scenarios', `qa:${x.id}`); } catch (err) { throw new C.WorkspaceError(err.status || 402, err.code || 'QUOTA_EXCEEDED', err.message); }
    }
    // Claim the result (CAS) so a concurrent duplicate submission cannot score it twice.
    const claimed = await store.update('qa_results', r.workspace_id, x.id, { status: 'running', started_at: x.started_at || iso() }, { expectVersion: x.version });
    if (!claimed) { if (handle) await usage.release(handle); throw C.conflict('The result was submitted concurrently', 'QA_RESULT_BUSY'); }
    const record = {
      source: 'external', status, failureCode: body.failureCode ? C.str(body.failureCode, 'failureCode', { max: 80 }) : null,
      failureMessage: body.failureMessage ? C.str(body.failureMessage, 'failureMessage', { max: 500 }) : null,
      resultText: typeof body.output === 'string' ? body.output.slice(0, 20000) : JSON.stringify(body.output || '').slice(0, 20000),
      verificationStatus: body.verificationStatus ? C.oneOf(body.verificationStatus, 'verificationStatus', ['verified', 'unverified', 'failed', 'not_applicable']) : null,
      actions: cleanActions, durationMs: body.durationMs === undefined ? null : C.int(body.durationMs, 'durationMs', { min: 0, max: 86400000 }),
      retries: 0, recovered: false, policyDenials: cleanActions.filter((a) => DENIAL_CODES.has(a.errorCode)).length, injectionDetected: false,
    };
    const probe = await runProbe(r.workspace_id, r.triggered_by, scenario.expected && scenario.expected.probe, x.id);
    const u = await finalize(claimed, scenario, r, record, { probe });
    if (handle) await usage.commit(handle, { source: 'qa_result', sourceId: x.id, actorId: ctx.userId }).catch(() => {});
    return { replayed: false, result: resultView(u || claimed) };
  }

  // ------------------------------------------------------------------
  // Worker
  // ------------------------------------------------------------------
  function sysCtx(run) {
    return { workspace: { id: run.workspace_id }, role: null, userId: run.triggered_by, ...(run.trigger === 'api' ? { apiKeyId: 'qa-api-trigger' } : {}) };
  }

  async function requeue(result, seconds) {
    // Keep it running; the claim picks it up again when this short lease expires.
    await store.update('qa_results', result.workspace_id, result.id, { lease_expires_at: new Date(now().getTime() + seconds * 1000).toISOString() }, { expectVersion: result.version });
  }

  /** Process one claimed result a step further. */
  async function processResult(result) {
    const ws = result.workspace_id;
    const [run, scenario] = await Promise.all([store.get('qa_runs', ws, result.run_id), store.get('qa_scenarios', ws, result.scenario_id)]);
    if (!run || !scenario) return null;
    if (run.status === 'cancelled') return store.update('qa_results', ws, result.id, { status: 'cancelled', finished_at: iso(), lease_owner: null, lease_expires_at: null }, { expectVersion: result.version });
    const project = await store.get('qa_projects', ws, run.project_id);
    const started = Date.parse(result.started_at || iso());
    const timedOut = now().getTime() - started > scenario.timeout_seconds * 1000;

    if (!result.execution_id && !result.workflow_run_id) {
      if (timedOut) return markError(result, run, 'QA_START_TIMEOUT', 'The scenario could not be started within its timeout (workspace busy).');
      let handle = null;
      if (usage) {
        try { handle = await usage.begin(ws, 'agent_test_scenarios', `qa:${result.id}`); } catch (err) { return markError(result, run, err.code || 'QUOTA_EXCEEDED', err.message); }
      }
      try {
        let patch;
        if (scenario.executor === 'nexus_agent') {
          const out = await executionService.createExecution(sysCtx(run), { goal: scenario.goal, idempotencyKey: `qa:${result.id}`, ...(project && project.agent_id ? { agentId: project.agent_id } : {}) });
          patch = { execution_id: out.execution.id };
        } else {
          const out = await workflowService.startRun(sysCtx(run), scenario.workflow_id, { inputs: scenario.inputs || {}, trigger: 'manual' }, { idempotencyKey: `qa-${result.id}` });
          patch = { workflow_run_id: out.run.id };
        }
        if (handle) await usage.commit(handle, { source: 'qa_result', sourceId: result.id, actorId: run.triggered_by }).catch(() => {});
        const u = await store.update('qa_results', ws, result.id, { ...patch, lease_expires_at: new Date(now().getTime() + pollSeconds * 1000).toISOString() }, { expectVersion: result.version });
        return u;
      } catch (err) {
        if (handle) await usage.release(handle);
        if (err.code === 'EXECUTION_IN_PROGRESS') { await requeue(result, pollSeconds * 2); return null; }
        return markError(result, run, err.code || 'START_FAILED', err.message);
      }
    }
    const record = result.execution_id ? await executionRecord(ws, result.execution_id) : await workflowRecord(ws, result.workflow_run_id);
    if (!record) return markError(result, run, 'RECORD_MISSING', 'The execution or run record no longer exists.');
    if (record.active) {
      if (timedOut) {
        if (result.execution_id) await executionService.abortExecution(ws, result.execution_id, { status: 'failed', code: 'QA_TIMEOUT', message: 'QA scenario timeout.' }).catch(() => {});
        else if (workflowService) await workflowService.cancelRun(sysCtx(run), result.workflow_run_id).catch(() => {});
        const again = result.execution_id ? await executionRecord(ws, result.execution_id) : await workflowRecord(ws, result.workflow_run_id);
        const rec = { ...(again || record), status: 'failed', active: false, failureCode: 'QA_TIMEOUT', failureMessage: 'The scenario exceeded its timeout.' };
        return finalize(result, scenario, run, rec);
      }
      await requeue(result, pollSeconds);
      return null;
    }
    const probe = await runProbe(ws, run.triggered_by, scenario.expected && scenario.expected.probe, result.id);
    return finalize(result, scenario, run, record, { probe });
  }

  async function tick({ max = 5 } = {}) {
    let n = 0;
    for (let i = 0; i < max; i++) {
      const rows = await store.rpc('claim_qa_result', { p_worker: workerId, p_lease_seconds: 120 });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) break;
      n += 1;
      try { await processResult(row); } catch (err) { logger.error?.(`[qa] result processing failed (${err.code || err.name})`); }
    }
    return n;
  }

  return {
    createProject, listProjects, getProject, deleteProject, createSuite, createScenario, deleteScenario,
    startRun, getRun, listRuns, cancelRun, submitExternalResult, projectMetrics, tick, processResult, report, workerId,
  };
}

module.exports = { createQaService, EXECUTORS };
