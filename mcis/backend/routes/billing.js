/**
 * Layer 7 — billing / usage API.
 *
 * /api/workspaces/:workspaceId/billing   (Firebase auth + Layer 1 workspaceContext)
 *   GET  /                        plan, subscription status, period, usage meters, remaining   (member+)
 *   GET  /plans                   plan catalogue (limits, display price if configured)       (member+)
 *   GET  /usage?days=             daily usage history (bounded by the plan's retention)       (member+)
 *   GET  /dashboard?days=         executions, runs, success/failure rate, steps, connector calls, trend (member+)
 *   POST /subscription/checkout   { planId } → provider checkout URL, or 501 when no provider  (admin+)
 *   POST /subscription/cancel     → cancel at period end (Stripe) / provider portal, or 501     (admin+)
 *   POST /subscription/portal     → provider-hosted billing portal URL, or 501                  (admin+, Layer 8)
 *
 * /api/billing/webhooks/:provider  (NO user auth — authenticated by the provider
 *   signature; mounted before the JSON body parser so the raw body is verified)
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext } = require('../middleware/workspaceContext');
const { QuotaError } = require('../services/billing/entitlementService');
const { WebhookError } = require('../services/billing/providers');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || err instanceof QuotaError || (err && err.name === 'ProviderError')) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (logger && logger.error) logger.error(`Billing route error: ${err && (err.code || err.name)}`);
  return res.status(500).json({ success: false, error: 'Billing service error' });
}

function createBillingRouter({ workspaceService, billingService, subscriptionService, logger } = {}) {
  const wsSvc = workspaceService || createWorkspaceService(createSupabaseWorkspaceStore());
  const router = express.Router({ mergeParams: true });
  router.use(workspaceContext(wsSvc, { logger }));
  const h = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, data: await fn(req) });
    } catch (err) { return sendError(res, err, logger); }
  };
  router.get('/', h((req) => billingService.summary(req.workspace)));
  router.get('/plans', h((req) => billingService.plans(req.workspace)));
  router.get('/usage', h((req) => billingService.history(req.workspace, { days: req.query.days })));
  router.get('/dashboard', h((req) => billingService.dashboard(req.workspace, { days: req.query.days })));
  router.post('/subscription/checkout', h((req) => subscriptionService.requestCheckout(req.workspace, { planId: req.body && req.body.planId })));
  router.post('/subscription/cancel', h((req) => subscriptionService.requestCancel(req.workspace)));
  // Layer 8: provider-hosted subscription management (owner/admin).
  router.post('/subscription/portal', h((req) => subscriptionService.requestPortal(req.workspace)));
  return router;
}

function createBillingWebhookRouter({ subscriptionService, logger = console } = {}) {
  const router = express.Router();
  router.post('/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
      const out = await subscriptionService.applyWebhook(String(req.params.provider).toLowerCase(), req.body, req.headers);
      return res.json({ received: true, status: out.status });
    } catch (err) {
      if (err instanceof WebhookError) {
        logger.warn?.(`[billing] webhook rejected: ${err.code}`);
        return res.status(err.status).json({ received: false, code: err.code });
      }
      logger.error?.(`[billing] webhook error: ${err.code || err.name}`);
      return res.status(500).json({ received: false, code: 'WEBHOOK_ERROR' }); // provider retries
    }
  });
  return router;
}

/** BILLING_ENABLED: off unless exactly 'true'. */
function billingFlag(env = process.env) {
  return env.BILLING_ENABLED === 'true';
}

/**
 * Production wiring. One entitlement/usage service shared by Layer 1
 * (members), Layer 3 (executions, steps, connector calls), Layer 4
 * (workflow runs, active workflows) and the Layer 6 automation API.
 */
function createBillingSystem({ workspaceService, executionService, logger = console } = {}) {
  const { createSupabaseBillingStore } = require('../services/billing/billingStore');
  const { createEntitlementService, createBillingAudit } = require('../services/billing/entitlementService');
  const { createSubscriptionService } = require('../services/billing/subscriptionService');
  const { createBillingService } = require('../services/billing/billingService');
  const { createProviders } = require('../services/billing/providers');
  const { createSupabaseWorkflowStore } = require('../services/workflows/workflowStore');
  const { createSupabaseExecutionStore } = require('../services/agentExecution/executionStore');
  const { appendAuditLog } = require('../security-engine/auditLog');

  const enabled = billingFlag();
  const store = createSupabaseBillingStore();
  const wsStore = createSupabaseWorkspaceStore();
  const wfStore = createSupabaseWorkflowStore();
  const execStore = createSupabaseExecutionStore();
  const counters = createCounters({ wsStore, wfStore, execStore });
  const audit = createBillingAudit({ appendAuditLog, logger });
  const providers = createProviders();
  const entitlements = createEntitlementService({
    store, enabled, counters, audit, logger,
    options: { pastDueGraceDays: parseInt(process.env.BILLING_PAST_DUE_GRACE_DAYS, 10) || 7 },
  });
  const subscriptions = createSubscriptionService({ store, providers, entitlements, audit, logger });
  const billing = createBillingService({ store, entitlements, providers, counters, enabled, logger });
  const execSvc = executionService || require('./executions').executionService;
  execSvc.setUsageMeter(entitlements);
  if (workspaceService && workspaceService.setEntitlements) workspaceService.setEntitlements(entitlements);
  logger.info?.(`Billing: ${enabled ? 'ENFORCING plan limits' : 'metering only (BILLING_ENABLED is not "true")'}; payment provider: ${providers.activeName}${providers.active.configured ? '' : ' (not configured)'}`);
  return {
    enabled, entitlements, subscriptions, billing, providers, store, counters, // Layer 10: counters are extended by the revenue suite
    router: createBillingRouter({ workspaceService, billingService: billing, subscriptionService: subscriptions, logger }),
    webhookRouter: createBillingWebhookRouter({ subscriptionService: subscriptions, logger }),
  };
}

/** Server-side counts for count capabilities (never client-supplied). */
function createCounters({ wsStore, wfStore, execStore, now = () => new Date() }) {
  return {
    async members(ws) {
      const [members, invites] = await Promise.all([wsStore.listMembers(ws), wsStore.listInvitations(ws)]);
      const pending = (invites || []).filter((i) => i.status === 'pending' && new Date(i.expires_at).getTime() > now().getTime()).length;
      return members.length + pending;
    },
    async active_workflows(ws, limit) {
      return (await wfStore.listWorkflows(ws, { status: 'active', limit: Math.min((limit || 0) + 1, 10000) })).length;
    },
    async concurrent_executions(ws) {
      return (await execStore.findActiveExecution(ws)) ? 1 : 0;
    },
  };
}

module.exports = { createBillingRouter, createBillingWebhookRouter, createBillingSystem, createCounters, billingFlag };
