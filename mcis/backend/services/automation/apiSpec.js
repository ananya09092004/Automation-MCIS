/**
 * Layer 8 — machine-readable documentation of the workspace API-key
 * surface (/api/automation/v1). Served publicly at
 * GET /api/automation/v1/openapi.json (no key needed, no workspace data)
 * and rendered by the /developers page. A test checks every documented
 * route exists in the router and every route is documented.
 *
 * Examples use placeholders only — never a real key.
 */
'use strict';

const { SCOPES } = require('../security/apiKeyService');

const KEY_PLACEHOLDER = 'nxk_<prefix>_<secret>';

const ERROR_CODES = Object.freeze([
  { status: 400, code: 'BAD_REQUEST', meaning: 'The request is malformed (e.g. missing goal, missing or invalid Idempotency-Key).' },
  { status: 400, code: 'KEY_IN_URL', meaning: 'An API key was sent in the URL. Send it only in the Authorization header.' },
  { status: 400, code: 'INVALID_CURSOR', meaning: 'The pagination cursor is malformed. Pass back nextCursor exactly as returned.' },
  { status: 400, code: 'INVALID_LIMIT', meaning: 'limit must be an integer between 1 and 100.' },
  { status: 400, code: 'INVALID_FILTER', meaning: 'A list filter (status, workflowId) has an invalid value.' },
  { status: 400, code: 'WORKFLOW_ID_REQUIRED', meaning: 'This key is limited to several workflows; pass workflowId when listing runs.' },
  { status: 400, code: 'INVALID_WORKFLOW', meaning: 'The workflow inputs do not match its variables.' },
  { status: 401, code: 'INVALID_API_KEY', meaning: 'Missing, malformed, revoked, expired or unknown key.' },
  { status: 402, code: 'QUOTA_EXCEEDED', meaning: "The workspace's plan limit for this month is used up (API calls, executions or workflow runs)." },
  { status: 402, code: 'FEATURE_NOT_IN_PLAN', meaning: "The workspace's plan does not include API access." },
  { status: 403, code: 'FORBIDDEN', meaning: 'The key lacks the required scope, or is restricted to other workflows.' },
  { status: 404, code: 'WORKFLOW_NOT_FOUND', meaning: 'No such workflow in the key\'s workspace (other workspaces are never visible).' },
  { status: 404, code: 'RUN_NOT_FOUND', meaning: 'No such run in the key\'s workspace.' },
  { status: 404, code: 'EXECUTION_NOT_FOUND', meaning: 'No such execution in the key\'s workspace.' },
  { status: 404, code: 'NOT_FOUND', meaning: 'No such QA project/run/result or monitor in the key\'s workspace.' },
  { status: 400, code: 'NOT_API_SUBMISSION', meaning: 'Observations can only be submitted to monitors whose source type is api_submission.' },
  { status: 400, code: 'NOT_EXTERNAL', meaning: 'Results can only be submitted for external_agent scenarios.' },
  { status: 409, code: 'QA_RESULT_BUSY', meaning: 'The QA result is not waiting for a submission (or one is in progress).' },
  { status: 503, code: 'QA_DISABLED', meaning: 'Agent reliability testing is not enabled on this server.' },
  { status: 503, code: 'MONITORING_DISABLED', meaning: 'Monitoring / competitor intelligence is not enabled on this server.' },
  { status: 409, code: 'TRIGGER_NOT_ENABLED', meaning: 'The workflow does not allow API triggering (enable the "api" trigger first).' },
  { status: 409, code: 'EXECUTION_IN_PROGRESS', meaning: 'Another execution is running in this workspace; retry later with the same Idempotency-Key.' },
  { status: 409, code: 'IDEMPOTENCY_CONFLICT', meaning: 'The Idempotency-Key was already used for a different request.' },
  { status: 429, code: 'RATE_LIMITED', meaning: 'Too many requests for this key (60/minute) or too many failed authentications from this address.' },
  { status: 503, code: 'ENTITLEMENT_UNAVAILABLE', meaning: 'Plan limits could not be verified; nothing was started. Retry later.' },
]);

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorResponses = (...codes) => Object.fromEntries(codes.map((c) => [String(c), { description: ERROR_CODES.filter((e) => e.status === c).map((e) => e.code).join(' | '), content: { 'application/json': { schema: ref('Error') } } }]));

function buildApiSpec({ serverUrl = null } = {}) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Nexus Automation API',
      version: '1',
      description: [
        'Run approved workflows and agent executions in ONE workspace with a workspace API key.',
        'Every request goes through the same checks as the app: workspace isolation, the key\'s scopes (member rights at most),',
        'plan quotas, the Agent Firewall and human approvals. A key can never approve an action.',
      ].join(' '),
    },
    ...(serverUrl ? { servers: [{ url: `${serverUrl.replace(/\/+$/, '')}/api/automation/v1` }] } : {}),
    'x-nexus': {
      authentication: {
        header: `Authorization: Bearer ${KEY_PLACEHOLDER}`,
        alternative: `X-Api-Key: ${KEY_PLACEHOLDER}`,
        notes: [
          'Create keys in Security → API keys (owner/admin). The full key is shown ONCE; Nexus stores only a hash.',
          'Keys in the URL (?api_key=, ?key=, ?token=) are rejected.',
          'Revoked or rotated keys stop working immediately.',
        ],
      },
      scopes: {
        'workflows:run': 'Start runs of workflows whose trigger allows "api" (optionally restricted to listed workflows).',
        'runs:read': 'Read run and execution status.',
        'executions:run': 'Submit single agent executions.',
        'qa:run': 'Start agent QA runs and submit external agents\' results (Layer 10).',
        'qa:read': 'Read QA runs, verdicts and reliability metrics.',
        'monitoring:read': 'Read monitors, observations, changes, alerts and the competitor dashboard.',
        'monitoring:write': 'Submit observations to api_submission monitors (always recorded as UNVERIFIED).',
        'usage:read': 'Read the plan\'s usage meters.',
      },
      webhooks: [
        'Admins register https endpoints in the app (Developers → Webhooks). Events: execution.completed, execution.failed, workflow_run.completed, workflow_run.failed, alert.created, monitor.changed, recommendation.created, qa_run.completed.',
        'Each delivery is signed: Nexus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>. Verify it and reject timestamps older than 5 minutes.',
        'Deliveries are retried with exponential backoff (up to 8 attempts); the same event id is never queued twice for one endpoint.',
      ],
      idempotency: [
        'POST requests REQUIRE an Idempotency-Key header (8-128 characters of A-Z a-z 0-9 _ . : -).',
        'Repeating a request with the same key returns the original run/execution with HTTP 200 and "replayed": true — it is never started or charged twice.',
        'Use a new key for a new piece of work; reuse the key when retrying after a timeout or 5xx.',
      ],
      quotas: [
        'Every authenticated request counts as one API call against the plan\'s monthly API-call limit.',
        'Runs and executions also count against their own monthly limits. Limits are reserved atomically, so parallel requests cannot exceed them.',
        'When a limit is reached the request fails with 402 QUOTA_EXCEEDED and nothing is started.',
        'Refused requests (invalid key, missing scope, quota exceeded, firewall denial) do not consume run or execution quota.',
      ],
      rateLimits: ['60 requests per minute per key (429 RATE_LIMITED).', '30 failed authentications per 5 minutes per client address.'],
      versioning: [
        'The version is in the path (/api/automation/v1). Within v1, fields and endpoints are only ever ADDED; nothing is removed or renamed.',
        'A breaking change would ship as /api/automation/v2 with v1 kept running during a published deprecation window.',
      ],
      pagination: 'List endpoints return { items, nextCursor }, newest first. Pass nextCursor back as ?cursor= for the next page; null means the last page. limit: 1-100 (default 20).',
      requestIds: 'Every response carries an X-Request-Id header (you may send your own, 8-128 characters of A-Z a-z 0-9 . _ : -). Quote it when contacting support.',
      approvals: 'If an action needs approval the execution/run waits (status "waiting_approval") until a workspace member approves it in the app. Poll the GET endpoint; do not resubmit.',
      errors: ERROR_CODES,
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'nxk_<prefix>_<secret>' } },
      schemas: {
        Error: { type: 'object', required: ['success', 'error', 'code'], properties: { success: { type: 'boolean', enum: [false] }, error: { type: 'string' }, code: { type: 'string' } } },
        RunRequest: { type: 'object', properties: { inputs: { type: 'object', additionalProperties: true, description: 'Values for the workflow variables (validated and redacted server-side).' } } },
        RunPage: { type: 'object', properties: { items: { type: 'array', items: ref('Run') }, nextCursor: { type: 'string', nullable: true } } },
        ExecutionPage: { type: 'object', properties: { items: { type: 'array', items: ref('Execution') }, nextCursor: { type: 'string', nullable: true } } },
        ExecutionRequest: { type: 'object', required: ['goal'], properties: { goal: { type: 'string', minLength: 1, maxLength: 2000 } } },
        Evidence: { type: 'object', description: 'Per-step evidence: action, risk tier, status, attempts, redacted output, verification, approval id, timestamps.' },
        QaRunRequest: { type: 'object', properties: { suiteId: { type: 'string', format: 'uuid' }, scenarioIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 200 } } },
        QaRun: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['queued', 'running', 'completed', 'cancelled'] }, scenarioCount: { type: 'integer' }, summary: { type: 'object' }, results: { type: 'array', items: ref('QaResult') }, report: { type: 'object' } } },
        QaResult: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }, scenarioId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['pending', 'running', 'awaiting_submission', 'passed', 'failed', 'error', 'cancelled'] },
            verdict: { type: 'object', nullable: true }, failureCategory: { type: 'string', nullable: true }, verified: { type: 'boolean', nullable: true }, evidenceComplete: { type: 'boolean', nullable: true },
          },
        },
        QaSubmission: {
          type: 'object', required: ['status'],
          properties: {
            status: { type: 'string', enum: ['completed', 'failed'] }, output: { description: 'What the agent produced (text or JSON).' },
            actions: { type: 'array', maxItems: 200, items: { type: 'object', required: ['action', 'status'], properties: { action: { type: 'string' }, status: { type: 'string', enum: ['succeeded', 'failed'] }, errorCode: { type: 'string' }, errorMessage: { type: 'string' }, verification: { type: 'string', enum: ['verified', 'unverified', 'failed', 'not_applicable'] } } } },
            durationMs: { type: 'integer' }, failureCode: { type: 'string' }, failureMessage: { type: 'string' }, verificationStatus: { type: 'string', enum: ['verified', 'unverified', 'failed', 'not_applicable'] },
          },
        },
        Monitor: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, kind: { type: 'string', enum: ['product', 'page', 'api_value'] }, health: { type: 'string', enum: ['PENDING', 'VERIFIED', 'UNVERIFIED', 'STALE', 'UNAVAILABLE'] }, current: { nullable: true }, currentIsFresh: { type: 'boolean' }, lastSuccessAt: { type: 'string', nullable: true } } },
        Observation: { type: 'object', required: ['values'], properties: { values: { type: 'object', description: 'Field values (product monitors: price, currency, listPrice, availability, seller, title, sku, gtin, mpn, brand, model).' }, present: { type: 'boolean', description: 'false = the product no longer exists at the source' } } },
        Run: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }, workspaceId: { type: 'string', format: 'uuid' }, workflowId: { type: 'string', format: 'uuid' },
            version: { type: 'integer' }, trigger: { type: 'string', enum: ['manual', 'scheduled', 'api'] },
            status: { type: 'string', enum: ['queued', 'running', 'waiting_approval', 'needs_review', 'completed', 'failed', 'cancelled'] },
            result: { nullable: true }, verification: { nullable: true }, failure: { nullable: true, type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
            replayed: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, finishedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Execution: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }, workspaceId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['created', 'planning', 'waiting_approval', 'executing', 'verifying', 'completed', 'failed', 'cancelled'] },
            goal: { type: 'string' }, progress: { type: 'object', properties: { stepsExecuted: { type: 'integer' }, maxSteps: { type: 'integer' } } },
            waitingForApproval: { nullable: true, type: 'object' }, result: { nullable: true }, verification: { nullable: true },
            failure: { nullable: true, type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
            evidenceSummary: { type: 'object' }, replayed: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/workflows/{workflowId}/runs': {
        post: {
          summary: 'Start a workflow run', 'x-scope': 'workflows:run',
          parameters: [
            { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } },
          ],
          requestBody: { content: { 'application/json': { schema: ref('RunRequest') } } },
          responses: {
            201: { description: 'Run created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('Run') } } } } },
            200: { description: 'Replay of an earlier request with the same Idempotency-Key (not started again)' },
            ...errorResponses(400, 401, 402, 403, 404, 409, 429, 503),
          },
        },
      },
      '/runs': {
        get: {
          summary: 'List runs (newest first, paginated)', 'x-scope': 'runs:read',
          parameters: [
            { name: 'workflowId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['queued', 'running', 'waiting_approval', 'needs_review', 'completed', 'failed', 'cancelled'] } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'One page of runs', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('RunPage') } } } } }, ...errorResponses(400, 401, 402, 403, 404, 429) },
        },
      },
      '/runs/{runId}': {
        get: {
          summary: 'Get a run (status, result, verification)', 'x-scope': 'runs:read',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'The run', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('Run') } } } } }, ...errorResponses(401, 402, 403, 404, 429) },
        },
      },
      '/executions': {
        get: {
          summary: 'List executions (newest first, paginated)', 'x-scope': 'runs:read',
          parameters: [
            { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['created', 'planning', 'waiting_approval', 'executing', 'verifying', 'completed', 'failed', 'cancelled'] } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'One page of executions', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('ExecutionPage') } } } } }, ...errorResponses(400, 401, 402, 403, 429) },
        },
        post: {
          summary: 'Submit an agent execution', 'x-scope': 'executions:run',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ExecutionRequest') } } },
          responses: {
            201: { description: 'Execution created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('Execution') } } } } },
            200: { description: 'Replay of an earlier request with the same Idempotency-Key (not started again)' },
            ...errorResponses(400, 401, 402, 403, 409, 429, 503),
          },
        },
      },
      '/executions/{executionId}/evidence': {
        get: {
          summary: 'Get an execution\'s evidence (every attempted step)', 'x-scope': 'runs:read',
          parameters: [{ name: 'executionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Evidence', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('Evidence') } } } } }, ...errorResponses(401, 402, 403, 404, 429) },
        },
      },
      '/runs/{runId}/evidence': {
        get: {
          summary: 'Get a run\'s evidence (steps, their executions and verification)', 'x-scope': 'runs:read',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Evidence', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('Evidence') } } } } }, ...errorResponses(401, 402, 403, 404, 429) },
        },
      },
      '/qa/projects/{projectId}/runs': {
        post: {
          summary: 'Start an agent QA run', 'x-scope': 'qa:run',
          parameters: [
            { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } },
          ],
          requestBody: { content: { 'application/json': { schema: ref('QaRunRequest') } } },
          responses: { 201: { description: 'QA run started', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('QaRun') } } } } }, 200: { description: 'Replay (not started again)' }, ...errorResponses(400, 401, 402, 403, 404, 409, 429, 503) },
        },
      },
      '/qa/runs/{runId}': {
        get: {
          summary: 'Get a QA run with verdicts and its report', 'x-scope': 'qa:read',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'QA run', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('QaRun') } } } } }, ...errorResponses(401, 402, 403, 404, 429, 503) },
        },
      },
      '/qa/runs/{runId}/results/{resultId}': {
        post: {
          summary: 'Submit an external agent\'s result for verification', 'x-scope': 'qa:run',
          parameters: [
            { name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'resultId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: ref('QaSubmission') } } },
          responses: { 201: { description: 'Verified and scored', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('QaResult') } } } } }, 200: { description: 'Already scored (replay)' }, ...errorResponses(400, 401, 402, 403, 404, 409, 429, 503) },
        },
      },
      '/qa/projects/{projectId}/metrics': {
        get: {
          summary: 'Reliability metrics over recent completed runs', 'x-scope': 'qa:read',
          parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'runs', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }],
          responses: { 200: { description: 'Metrics' }, ...errorResponses(401, 402, 403, 404, 429, 503) },
        },
      },
      '/monitoring/monitors': {
        get: {
          summary: 'List monitors', 'x-scope': 'monitoring:read',
          parameters: [{ name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['product', 'page', 'api_value'] } }, { name: 'health', in: 'query', required: false, schema: { type: 'string', enum: ['PENDING', 'VERIFIED', 'UNVERIFIED', 'STALE', 'UNAVAILABLE'] } }],
          responses: { 200: { description: 'Monitors', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: ref('Monitor') } } } } } }, ...errorResponses(400, 401, 402, 403, 429, 503) },
        },
      },
      '/monitoring/monitors/{monitorId}': {
        get: {
          summary: 'Get a monitor with recent observations, changes and history', 'x-scope': 'monitoring:read',
          parameters: [{ name: 'monitorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Monitor' }, ...errorResponses(401, 402, 403, 404, 429, 503) },
        },
      },
      '/monitoring/monitors/{monitorId}/observations': {
        post: {
          summary: 'Submit an observation to an api_submission monitor (recorded as UNVERIFIED)', 'x-scope': 'monitoring:write',
          parameters: [
            { name: 'monitorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: ref('Observation') } } },
          responses: { 201: { description: 'Recorded (changes detected deterministically)' }, 200: { description: 'Replay (not recorded again)' }, ...errorResponses(400, 401, 402, 403, 404, 429, 503) },
        },
      },
      '/monitoring/changes': {
        get: {
          summary: 'Detected changes, newest first', 'x-scope': 'monitoring:read',
          parameters: [{ name: 'monitorId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } }, { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } }],
          responses: { 200: { description: 'Changes' }, ...errorResponses(400, 401, 402, 403, 429, 503) },
        },
      },
      '/monitoring/alerts': {
        get: {
          summary: 'Alerts with per-channel delivery state', 'x-scope': 'monitoring:read',
          parameters: [{ name: 'acknowledged', in: 'query', required: false, schema: { type: 'boolean' } }],
          responses: { 200: { description: 'Alerts' }, ...errorResponses(401, 402, 403, 429, 503) },
        },
      },
      '/competitors/dashboard': {
        get: {
          summary: 'Competitor intelligence dashboard (products, verified matches, margin impact)', 'x-scope': 'monitoring:read',
          responses: { 200: { description: 'Dashboard' }, ...errorResponses(401, 402, 403, 429, 503) },
        },
      },
      '/usage': {
        get: {
          summary: 'Plan usage meters for the current period', 'x-scope': 'usage:read',
          responses: { 200: { description: 'Usage' }, ...errorResponses(401, 402, 403, 429, 503) },
        },
      },
      '/executions/{executionId}': {
        get: {
          summary: 'Get an execution (status, progress, approval state, evidence summary)', 'x-scope': 'runs:read',
          parameters: [{ name: 'executionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'The execution', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: ref('Execution') } } } } }, ...errorResponses(401, 402, 403, 404, 429) },
        },
      },
    },
  };
}

/** Copyable examples (placeholders only). */
function buildExamples(baseUrl = 'https://<your-nexus-host>') {
  const b = `${baseUrl.replace(/\/+$/, '')}/api/automation/v1`;
  return {
    curlRun: `curl -X POST "${b}/workflows/<workflow-id>/runs" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY" \\\n  -H "Idempotency-Key: order-2026-0001" \\\n  -H "Content-Type: application/json" \\\n  -d '{"inputs": {"company": "Example Ltd"}}'`,
    curlExecution: `curl -X POST "${b}/executions" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY" \\\n  -H "Idempotency-Key: research-2026-0001" \\\n  -H "Content-Type: application/json" \\\n  -d '{"goal": "Summarise the pricing page of example.com"}'`,
    curlList: `curl "${b}/runs?status=completed&limit=20" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY"`,
    curlStatus: `curl "${b}/executions/<execution-id>" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY"`,
    node: `const res = await fetch("${b}/executions", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.NEXUS_API_KEY}\`,\n    "Idempotency-Key": "research-2026-0001",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ goal: "Summarise the pricing page of example.com" }),\n});\nconst { data } = await res.json();`,
  };
}

module.exports = { buildApiSpec, buildExamples, ERROR_CODES, KEY_PLACEHOLDER, SCOPES };
