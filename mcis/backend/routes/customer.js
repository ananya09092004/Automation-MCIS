/**
 * Layer 8 — customer journey API.
 *
 * /api/onboarding                                   (Firebase auth; the caller's own onboarding only)
 *   GET  /                 state (+ whether onboarding is suggested for this user)
 *   POST /start            create the onboarding record (idempotent)
 *   POST /workspace        { mode: 'create', name } | { mode: 'existing', workspaceId } | { mode: 'personal' }
 *   POST /team             { invites: [{ email, role }] } | { skip: true }
 *   POST /use-case         { useCase }
 *   POST /template         { templateId, name? }   → first workflow (created + published by the user)
 *   POST /first-run        { inputs }               → first run (idempotent)
 *   POST /complete         finish / skip onboarding
 *
 * /api/workspaces/:workspaceId/templates           (Firebase auth + Layer 1 membership)
 *   GET  /                 catalogue + which required integrations this workspace has
 *   GET  /:templateId
 *   POST /:templateId/instantiate   { name?, integrations?: { <provider>: <integrationId> }, publish? }
 *
 * /api/workspaces/:workspaceId/overview            (member+; admin detail for owners/admins)
 *   GET  /
 *
 * Flags: ONBOARDING_ENABLED (default on; 'false' disables), TEMPLATES_ENABLED
 * (default on; 'false' disables). Nothing here bypasses Layers 1–7.
 */
'use strict';

const express = require('express');
const { WorkspaceError } = require('../services/workspaceService');
const { workspaceContext, toActor } = require('../middleware/workspaceContext');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || (err && (err.name === 'QuotaError' || err.name === 'ProviderError') && Number.isInteger(err.status))) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (logger && logger.error) logger.error(`Customer route error: ${err && (err.code || err.name)}`);
  return res.status(500).json({ success: false, error: 'Service error' });
}

const handler = (logger) => (fn, ok = 200) => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.status(ok).json({ success: true, data: await fn(req) });
  } catch (err) { return sendError(res, err, logger); }
};

function createOnboardingRouter({ onboardingService, logger } = {}) {
  const router = express.Router();
  const h = handler(logger);
  const actor = (req) => {
    const a = toActor(req);
    if (!a) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
    return a;
  };
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  router.get('/', h((req) => onboardingService.getState(actor(req))));
  router.post('/start', h((req) => onboardingService.start(actor(req))));
  router.post('/workspace', h((req) => onboardingService.chooseWorkspace(actor(req), body(req))));
  router.post('/team', h((req) => onboardingService.inviteTeam(actor(req), body(req))));
  router.post('/use-case', h((req) => onboardingService.chooseUseCase(actor(req), body(req))));
  router.post('/template', h((req) => onboardingService.createFirstWorkflow(actor(req), body(req))));
  router.post('/first-run', h((req) => onboardingService.runFirstTask(actor(req), body(req))));
  router.post('/complete', h((req) => onboardingService.complete(actor(req))));
  return router;
}

function createTemplatesRouter({ workspaceService, templateService, logger } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(workspaceContext(workspaceService, { logger }));
  const h = handler(logger);
  router.get('/', h((req) => templateService.listTemplates(req.workspace, { category: req.query.category, useCase: req.query.useCase })));
  router.get('/:templateId', h((req) => templateService.getTemplate(req.workspace, req.params.templateId)));
  router.post('/:templateId/instantiate', h((req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    // Only these fields are read: a client can never send steps, approvals or policies.
    return templateService.instantiate(req.workspace, req.params.templateId, { name: b.name, integrations: b.integrations, agents: b.agents, publish: b.publish === true });
  }, 201));
  return router;
}

function createOverviewRouter({ workspaceService, overviewService, logger } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(workspaceContext(workspaceService, { logger }));
  router.get('/', handler(logger)((req) => overviewService.overview(req.workspace)));
  return router;
}

const flagOn = (v) => v !== 'false'; // default ON

/** Production wiring: reuses the SAME Layer 1/3/4/5/7 services the server already built. */
function createCustomerSystem({
  workspaceService, workflowSystem = null, integrationSystem = null, billingSystem = null, logger = console, env = process.env,
} = {}) {
  const { createOnboardingService } = require('../services/onboarding/onboardingService');
  const { createSupabaseOnboardingStore } = require('../services/onboarding/onboardingStore');
  const { createTemplateService } = require('../services/templates/templateService');
  const { createOverviewService } = require('../services/customer/overviewService');
  const { createSupabaseExecutionStore } = require('../services/agentExecution/executionStore');
  const { createSupabaseWorkflowStore } = require('../services/workflows/workflowStore');
  const { createSupabaseWorkspaceDataStore } = require('../services/workspaceData/workspaceDataStore');
  const { createSupabaseSecurityStore } = require('../services/security/securityStore');
  const { appendAuditLog, getWorkspaceAuditLog } = require('../security-engine/auditLog');

  const onboardingEnabled = flagOn(env.ONBOARDING_ENABLED);
  const templatesEnabled = flagOn(env.TEMPLATES_ENABLED) && !!workflowSystem;
  const workflowService = workflowSystem ? workflowSystem.service : null;
  const integrationStore = integrationSystem ? require('../services/integrations/integrationStore').createSupabaseIntegrationStore() : null;
  const templateService = workflowService ? createTemplateService({
    workflowService, integrationStore, integrationResolver: integrationSystem ? integrationSystem.service : null,
    entitlements: billingSystem ? billingSystem.entitlements : null, appendAuditLog, enabled: templatesEnabled, logger,
  }) : null;
  const onboardingService = createOnboardingService({
    store: createSupabaseOnboardingStore(), workspaceService, templateService: templatesEnabled ? templateService : null,
    workflowService, appendAuditLog, enabled: onboardingEnabled, logger,
  });
  const overviewService = createOverviewService({
    billingService: billingSystem ? billingSystem.billing : null,
    execStore: createSupabaseExecutionStore(), wfStore: workflowService ? createSupabaseWorkflowStore() : null,
    integrationStore, dataStore: createSupabaseWorkspaceDataStore(), getWorkspaceAuditLog, securityStore: createSupabaseSecurityStore(), logger,
  });
  logger.info?.(`Customer journey: onboarding ${onboardingEnabled ? 'on' : 'off'}, templates ${templatesEnabled ? 'on' : 'off'}`);
  return {
    onboardingEnabled, templatesEnabled, onboardingService, templateService, overviewService,
    onboardingRouter: createOnboardingRouter({ onboardingService, logger }),
    templatesRouter: templateService ? createTemplatesRouter({ workspaceService, templateService, logger }) : null,
    overviewRouter: createOverviewRouter({ workspaceService, overviewService, logger }),
  };
}

module.exports = { createOnboardingRouter, createTemplatesRouter, createOverviewRouter, createCustomerSystem, flagOn };
