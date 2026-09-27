const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const helmet = require('helmet');
require('dotenv').config();
const authenticateFirebaseUser = require('./middleware/auth');
const jobsRouter = require('./routes/jobs');
const notificationsRoute = require('./routes/notifications');
const commandCenterRoute = require('./routes/commandCenter');
const dataControlsRoute = require('./routes/dataControls');
const chatRoute = require('./routes/chat');
const uploadRoute = require('./routes/upload');
const memoryRoute = require('./routes/memory');
const imageRoute = require('./routes/image');
const voiceRoute = require('./routes/voice');
const goalsRoute = require('./routes/goals');
const eventsRoute = require('./routes/events');
const analyticsRoute = require('./routes/analytics');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/logger');
const winstonLogger = require('./services/logger');
const sanitizeInput = require('./middleware/sanitizer');
const graphRoute = require('./routes/graph');
const profileRoute = require('./routes/profile');
const app = express();
const futureRoute = require('./routes/future');
const twinRoute = require('./routes/twin');
const timelineRoute = require('./routes/timeline');
const codingRoute = require('./routes/coding');
const codeWithPipelineRoute = require('./routes/codeWithPipeline');
const codeQualityRoute = require('./routes/codeQuality');
const sandboxRoutes = require('./routes/sandbox');
const githubRoutes = require('./routes/github');
const multifileRoutes = require('./routes/multifile');
const { attachAgentSocket } = require('./agentSocket');
const commandRoute = require('./backend-routing/commandRoute');
const deviceRoute = require('./routes/device');
const devicePairing = require('./backend-addon/devicePairing');
const permissionsRoute = require('./routes/permissions');
const emergencyStopRoute = require('./routes/emergencyStop');
// Was never mounted anywhere, even though hybridOrchestrator.js and this
// route both existed in the repo — /:userId/execute-goal was unreachable.
const hybridRoute = require('./routes/hybrid');
// Layer 1 multi-tenant foundation (workspaces, roles, invitations).
// Only mounted on /api/workspaces — no work is added to the voice,
// command or agent routes.
const workspacesRoute = require('./routes/workspaces');
// Layer 3 agent execution & verification (workspace-scoped).
const executionsRoute = require('./routes/executions');
// Layer 2 workspace data scoping + collaboration (tasks, grants, audit).
const { workspaceDataScope } = require('./middleware/workspaceDataScope');
const { createWorkspaceService: createL2WorkspaceService } = require('./services/workspaceService');
const { createSupabaseWorkspaceStore: createL2WorkspaceStore } = require('./services/workspaceStore');
const l2WorkspaceService = createL2WorkspaceService(createL2WorkspaceStore());
const workspaceDataRouters = require('./routes/workspaceData').createWorkspaceDataRouters({
  workspaceService: l2WorkspaceService,
  executionService: executionsRoute.executionService,
  logger: winstonLogger,
});
// Layer 5 integrations (OFF unless INTEGRATIONS_ENABLED=true). Attaches the
// connector gateway to the SAME Layer 3 execution service.
const integrationSystem = process.env.INTEGRATIONS_ENABLED === 'true'
  ? require('./routes/integrations').createIntegrationSystem({
    workspaceService: l2WorkspaceService,
    executionService: executionsRoute.executionService,
    logger: winstonLogger,
  })
  : null;
// Layer 6 enterprise security: Agent Firewall (SECURITY_FIREWALL_ENABLED,
// default on) attached to the SAME Layer 3 execution service and Layer 5
// gateway, workspace security policy, API keys, OAuth state, security events.
const securitySystem = require('./routes/security').createSecuritySystem({
  workspaceService: l2WorkspaceService,
  executionService: executionsRoute.executionService,
  integrationSystem,
  logger: winstonLogger,
});
// Layer 7 usage metering / plans / entitlements / subscriptions. Metering is
// always on; plan limits are enforced only with BILLING_ENABLED=true.
const billingSystem = require('./routes/billing').createBillingSystem({
  workspaceService: l2WorkspaceService,
  executionService: executionsRoute.executionService,
  logger: winstonLogger,
});
workspacesRoute.workspaceService.setEntitlements(billingSystem.entitlements);
// Layer 9: invitation acceptance is rate limited (shared DB counter) and
// ownership transfers are audited, on BOTH workspace service instances.
{
  const { appendAuditLog } = require('./security-engine/auditLog');
  // Layer 10: optional invitation emails (INVITE_EMAIL_PROVIDER / _API_KEY / _FROM + APP_BASE_URL).
  const inviteMailer = require('./services/invitationMailer').createInvitationMailer({
    http: require('./services/integrations/safeHttp').createSafeHttpClient(), logger: winstonLogger,
  });
  for (const svc of [workspacesRoute.workspaceService, l2WorkspaceService]) {
    svc.setRateLimiter(securitySystem.rateLimiter);
    svc.setAudit(appendAuditLog);
    svc.setMailer(inviteMailer);
  }
}
// Layer 9 operations: retention, worker liveness, metrics, request ids.
const opsStore = require('./services/ops/opsStore').createSupabaseOpsStore();
const observability = require('./services/ops/observability');
const workerHealth = observability.createWorkerHealth({ store: opsStore, logger: winstonLogger });
const metrics = observability.createMetrics();
const retentionService = require('./services/ops/retentionService').createRetentionService({
  store: opsStore, appendAuditLog: require('./security-engine/auditLog').appendAuditLog, logger: winstonLogger,
});
// Layer 4 workflows + durable execution (workspace-scoped). Reuses the
// SAME Layer 3 execution service instance. WORKFLOWS_ENABLED=false turns
// off both the routes and the worker (e.g. before the migration is applied).
const workflowSystem = process.env.WORKFLOWS_ENABLED === 'false'
  ? null
  : require('./routes/workflows').createWorkflowSystem({
    workspaceService: l2WorkspaceService,
    executionService: executionsRoute.executionService,
    integrationResolver: integrationSystem ? integrationSystem.service : null,
    extraSafeActions: integrationSystem ? integrationSystem.registry.staticallySafeActionNames() : [],
    securityEvents: securitySystem.events,
    usage: billingSystem.entitlements,
    workerHealth,
    logger: winstonLogger,
  });
// Layer 8 customer journey: onboarding, workflow templates (Layer 4
// definitions only), workspace overview / customer-safe observability.
// Reuses the SAME Layer 1/3/4/5/7 services; ONBOARDING_ENABLED and
// TEMPLATES_ENABLED default on ('false' turns them off).
const customerSystem = require('./routes/customer').createCustomerSystem({
  workspaceService: l2WorkspaceService,
  workflowSystem,
  integrationSystem,
  billingSystem,
  logger: winstonLogger,
});
// Layer 10 revenue suite: competitor intelligence, monitoring + alerts,
// agent QA / reliability, AI workforce agents, signed webhooks, workspace
// export / delete. Reuses the SAME Layer 1–9 services (REVENUE_SUITE_ENABLED
// defaults on; 'false' turns routes and worker off).
const revenueSystem = require('./routes/revenue').revenueFlag()
  ? require('./routes/revenue').createRevenueSystem({
    workspaceService: l2WorkspaceService,
    integrationSystem,
    securitySystem,
    billingSystem,
    workflowSystem,
    executionService: executionsRoute.executionService,
    dataService: workspaceDataRouters.service,
    workerHealth,
    metrics,
    opsStore,
    retentionService,
    logger: winstonLogger,
  })
  : null;
if (customerSystem.templateService && revenueSystem && customerSystem.templateService.setAgentService) {
  customerSystem.templateService.setAgentService(revenueSystem.agents);
}
// ================================
// Middleware
// ================================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
console.log('DEBUG allowedOrigins:', allowedOrigins);

// Layer 9: correlation id + request metrics come first so every response has them.
app.use(observability.requestId());
app.use(metrics.middleware());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", ...allowedOrigins],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Layer 7: billing provider webhooks need the RAW body for signature
// verification, so they are mounted before the JSON parser (no user auth:
// the provider signature is the authentication).
app.use('/api/billing/webhooks', billingSystem.webhookRouter);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(sanitizeInput);

// Request logging middleware
app.use(requestLogger);

// Winston — har request log karo
app.use((req, res, next) => {
  winstonLogger.info(`${req.method} ${req.path}`);
  next();
});


// ================================
// Security Headers
// ================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});


// ================================
// Uploads Folder
// ================================
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}


// ================================
// Health Check
// ================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});


// Layer 9: readiness (DB + workers, counts only) and Prometheus metrics (METRICS_TOKEN).
const workersExpected = !!workflowSystem && process.env.WORKFLOW_WORKER_ENABLED !== 'false';
const { readinessHandler } = require('./routes/ops');
app.get('/health/ready', readinessHandler({
  checkDb: async () => { await opsStore.listHeartbeats(1); },
  workerHealth: workflowSystem ? workerHealth : null,
  requireWorkers: process.env.READINESS_REQUIRE_WORKERS === 'true',
}));
app.get('/metrics', observability.metricsHandler({
  metrics,
  gauges: async () => {
    if (!workflowSystem) return {};
    const s = await workerHealth.summary();
    return { nexus_workers_live: s.live, nexus_workers_stale: s.stale, nexus_worker_running_jobs: s.runningJobs, nexus_worker_expected: workersExpected ? 1 : 0 };
  },
}));

// ================================
// Routes
// ================================
try {
  // Layer 6: machine API authenticated ONLY by workspace API keys (own auth,
  // mounted before Firebase; nothing else accepts API keys).
  app.use('/api/automation/v1', require('./routes/automation').createAutomationRouter({
    apiKeyService: securitySystem.apiKeyService,
    workflowService: workflowSystem ? workflowSystem.service : null,
    executionService: executionsRoute.executionService,
    usage: billingSystem.entitlements,
    logger: winstonLogger,
    publicUrl: process.env.PUBLIC_API_URL || null,
    revenue: revenueSystem, // Layer 10: QA, monitoring, competitor dashboard
    billing: billingSystem.billing, // Layer 10: GET /usage
  }));
  app.use('/api', authenticateFirebaseUser);
  // Layer 8: the caller's own onboarding (no workspace id in the path).
  app.use('/api/onboarding', customerSystem.onboardingRouter);
  // Layer 2: chats / messages / memory / goals run inside the caller's
  // workspace scope (X-Workspace-Id header, default = personal workspace).
  // Deliberately NOT applied to /api/command, /api/voice or other routes.
  app.use(['/api/chat', '/api/memory', '/api/goals'], workspaceDataScope(l2WorkspaceService, { logger: winstonLogger }));
  app.use('/api/chat', chatRoute);
  app.use('/api/upload', uploadRoute);
  app.use('/api/memory', memoryRoute);
  app.use('/api/image', imageRoute);
  app.use('/api/voice', voiceRoute);
  app.use('/api/goals', goalsRoute);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/notifications', notificationsRoute);
  app.use('/api/command-center', commandCenterRoute);
  app.use('/api/data-controls', dataControlsRoute);
  app.use('/api/events', eventsRoute);
  app.use('/api/analytics', analyticsRoute);
  app.use('/api/graph', graphRoute);
  app.use('/api/profile', profileRoute);
  app.use('/api/twin', twinRoute);
  app.use('/api/future', futureRoute);
  app.use('/api/timeline', timelineRoute);
  app.use('/api/coding', codingRoute);
  app.use('/api/code-quality', codeQualityRoute);
  app.use('/api/code-pipeline', codeWithPipelineRoute);
  app.use('/api/sandbox', sandboxRoutes);
  app.use('/api/github', githubRoutes);
  app.use('/api/oauth', require('./routes/oauthCallbacks').createOAuthCallbackRouter()); // Layer 9
  app.use('/api/multifile', multifileRoutes);
  app.use('/api/command', commandRoute);
  app.use('/api/permissions', permissionsRoute);
  app.use('/api/hybrid', hybridRoute);
  app.use('/api/device', deviceRoute);
  app.use('/api/device', devicePairing);
  app.use('/api/emergency', emergencyStopRoute);
  app.use('/api/workspaces/:workspaceId/executions', executionsRoute);
  app.use('/api/workspaces/:workspaceId/tasks', workspaceDataRouters.tasks);
  app.use('/api/workspaces/:workspaceId/permissions', workspaceDataRouters.permissions);
  app.use('/api/workspaces/:workspaceId/audit', workspaceDataRouters.audit);
  app.use('/api/workspaces/:workspaceId/security', securitySystem.router);
  app.use('/api/workspaces/:workspaceId/billing', billingSystem.router);
  app.use('/api/workspaces/:workspaceId/overview', customerSystem.overviewRouter);
  app.use('/api/workspaces/:workspaceId/retention', require('./routes/ops').createRetentionRouter({
    workspaceService: l2WorkspaceService, retentionService, logger: winstonLogger,
  }));
  if (customerSystem.templatesRouter) {
    app.use('/api/workspaces/:workspaceId/templates', customerSystem.templatesRouter);
  }
  if (integrationSystem) {
    app.use('/api/workspaces/:workspaceId/integrations', integrationSystem.router);
  }
  if (revenueSystem) {
    const rr = revenueSystem.routers;
    app.use('/api/workspaces/:workspaceId/monitoring', rr.monitoring);
    app.use('/api/workspaces/:workspaceId/competitors', rr.competitors);
    app.use('/api/workspaces/:workspaceId/reliability', rr.reliability);
    app.use('/api/workspaces/:workspaceId/agents', rr.agents);
    app.use('/api/workspaces/:workspaceId/webhooks', rr.webhooks);
    app.use('/api/workspaces/:workspaceId/lifecycle', rr.lifecycle);
  }
  if (workflowSystem) {
    app.use('/api/workspaces/:workspaceId/workflows', workflowSystem.workflows);
    app.use('/api/workspaces/:workspaceId/workflow-runs', workflowSystem.runs);
  }
  app.use('/api/workspaces', workspacesRoute);
  winstonLogger.info('All routes loaded ✅');
} catch (err) {
  winstonLogger.error(`Route loading error: ${err.message}`);
}


// ================================
// Root Route
// ================================
app.get('/', (req, res) => {
  res.json({
    message: 'MCIS Backend Running!',
    version: '1.0.0',
    endpoints: [
      '/api/chat',
      '/api/upload',
      '/api/memory',
      '/api/image',
      '/api/voice',
      '/api/goals',
      '/api/command-center',
      '/api/data-controls',
      '/health'
    ]
  });
});
// ================================
// 404 Handler
// ================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});


// ================================
// Global Error Handler
// ================================
app.use((err, req, res, next) => {
  winstonLogger.error(`${err.message} | Route: ${req.path} | request ${req.requestId || '-'}`);
  res.status(500).json({ success: false, error: 'Something went wrong', requestId: req.requestId || null });
});

app.use(errorHandler);


// ================================
// Server Start
// ================================
// Was defaulting to 5000, while every client that talks to this server
// locally (nexus/voice/voice_controller.py's MCIS_COMMAND_URL,
// mcis-agent-final/pairing.js's BACKEND_HTTP_URL default) hardcoded an
// assumption of 5051. Unless PORT=5051 was explicitly set in this
// service's .env, the backend came up on 5000 and every one of those
// clients got ECONNREFUSED. Defaulting to 5051 here makes the whole
// stack agree out-of-the-box; PORT env var still overrides it the same
// as before (e.g. hosted deployments that set PORT themselves are
// unaffected).
const PORT = process.env.PORT || 5051;

const server = http.createServer(app);
attachAgentSocket(server);

server.listen(PORT, '0.0.0.0', () => {

  winstonLogger.info(`MCIS Server running on port ${PORT}`);
  winstonLogger.info(`Health check: http://localhost:${PORT}/health`);
  // Layer 4 durable workflow worker. Layer 3 runtimes are in-process, so
  // enable it in exactly ONE instance (WORKFLOW_WORKER_ENABLED=false elsewhere).
  if (workflowSystem && process.env.WORKFLOW_WORKER_ENABLED !== 'false') {
    workflowSystem.runner.start();
    winstonLogger.info(`Workflow worker started (${workflowSystem.runner.workerId})`);
    // Layer 9: periodic retention sweep on worker instances (idempotent, so
    // several workers sweeping is harmless). RETENTION_SWEEP_MINUTES=0 disables.
    // Layer 10: monitoring checks, QA runner, webhook deliveries (lease-based; safe on several instances).
    if (revenueSystem && process.env.REVENUE_WORKER_ENABLED !== 'false') {
      revenueSystem.worker.start();
      winstonLogger.info(`Revenue worker started (${revenueSystem.worker.workerId})`);
    }
    const sweepMin = Number(process.env.RETENTION_SWEEP_MINUTES || 360);
    if (Number.isFinite(sweepMin) && sweepMin > 0) {
      const t = setInterval(() => {
        retentionService.sweep().then((r) => { metrics.inc('nexus_retention_sweeps_total'); if (r.failed) winstonLogger.warn(`Retention sweep: ${r.failed} workspace(s) failed`); })
          .catch((err) => winstonLogger.error(`Retention sweep error: ${err.code || err.message}`));
      }, Math.max(5, sweepMin) * 60000);
      if (t.unref) t.unref();
    }
  }
});


// ================================
// Unhandled Errors
// ================================
process.on('unhandledRejection', (err) => {
  winstonLogger.error(`Unhandled Rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
  winstonLogger.error(`Uncaught Exception: ${err.message}`);
});
