/**
 * Layer 5 — workspace integrations (mounted at /api/workspaces/:workspaceId/integrations
 * ONLY when INTEGRATIONS_ENABLED=true).
 *
 *   GET    /providers                 available connectors, actions, risk tiers, input schemas   (member+)
 *   GET    /                          integrations of this workspace (metadata only)             (member+)
 *   POST   /                          { provider, name, config, credentials } → connect         (admin+)
 *   GET    /:integrationId            one integration + effective action permissions            (member+)
 *   PATCH  /:integrationId            { version, name?, config? }                               (admin+)
 *   POST   /:integrationId/credentials { credentials } → replace/rotate the secret              (admin+)
 *   POST   /:integrationId/disconnect  deletes the stored secret, status → disconnected         (admin+)
 *   POST   /:integrationId/reconnect   for integrations that need no credential                 (admin+)
 *   POST   /:integrationId/health      live check against the provider                          (admin+)
 *   PUT    /:integrationId/permissions { actions: { name: { enabled?, approval?, minRole? } } }  (admin+)
 *
 * No response ever contains a credential. Behind middleware/auth.js +
 * Layer 1 workspaceContext (non-members get 404; the workspace comes only
 * from the URL and is re-checked against the caller's membership).
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext } = require('../middleware/workspaceContext');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  }
  if (logger && logger.error) logger.error(`Integration route error (${err && err.name})`); // never the message: it could echo input
  return res.status(500).json({ success: false, error: 'Integration service error' });
}

function createIntegrationsRouter({ workspaceService, integrationService, logger } = {}) {
  if (!integrationService) throw new Error('integrationService is required');
  const svc = integrationService;
  const wsSvc = workspaceService || createWorkspaceService(createSupabaseWorkspaceStore());
  const router = express.Router({ mergeParams: true });
  router.use(workspaceContext(wsSvc, { logger }));
  // Responses may describe secrets' existence but never contain them; make
  // sure nothing is cached by intermediaries either.
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const h = (fn, ok = 200) => async (req, res) => {
    try {
      res.status(ok).json({ success: true, data: await fn(req) });
    } catch (err) {
      sendError(res, err, logger);
    }
  };

  router.get('/providers', h((req) => svc.listProviders(req.workspace)));
  router.get('/', h((req) => svc.listIntegrations(req.workspace)));
  router.post('/', h((req) => svc.createIntegration(req.workspace, req.body || {}), 201));
  router.get('/:integrationId', h((req) => svc.getIntegration(req.workspace, req.params.integrationId)));
  router.patch('/:integrationId', h((req) => svc.updateIntegration(req.workspace, req.params.integrationId, req.body || {})));
  router.post('/:integrationId/credentials', h((req) => svc.rotateCredential(req.workspace, req.params.integrationId, req.body || {})));
  router.post('/:integrationId/disconnect', h((req) => svc.disconnect(req.workspace, req.params.integrationId)));
  router.post('/:integrationId/reconnect', h((req) => svc.reconnectWithoutCredential(req.workspace, req.params.integrationId)));
  router.post('/:integrationId/health', h((req) => svc.healthCheck(req.workspace, req.params.integrationId)));
  router.put('/:integrationId/permissions', h((req) => svc.updatePermissions(req.workspace, req.params.integrationId, req.body || {})));
  return router;
}

/**
 * Production wiring. Attaches the gateway to the SHARED Layer 3 execution
 * service so connector steps run through the same engine. Without a valid
 * INTEGRATION_ENCRYPTION_KEY the system still mounts (metadata stays
 * readable) but every credential operation fails closed (503).
 */
function createIntegrationSystem({ workspaceService, executionService, logger } = {}) {
  const { createSupabaseIntegrationStore } = require('../services/integrations/integrationStore');
  const { createCredentialService, loadKeyRing } = require('../services/integrations/credentialService');
  const { createSafeHttpClient } = require('../services/integrations/safeHttp');
  const { createDefaultRegistry } = require('../services/integrations/connectorRegistry');
  const { createIntegrationService } = require('../services/integrations/integrationService');
  const { appendAuditLog } = require('../security-engine/auditLog');

  const wsStore = createSupabaseWorkspaceStore();
  const wsSvc = workspaceService || createWorkspaceService(wsStore);
  const store = createSupabaseIntegrationStore();
  const keyRing = loadKeyRing();
  if (keyRing.error && logger && logger.error) {
    logger.error(`Integrations: credential encryption unavailable (${keyRing.error}); credential operations will fail closed.`);
  }
  const registry = createDefaultRegistry();
  const service = createIntegrationService({
    store,
    registry,
    credentials: createCredentialService({ store, keyRing }),
    http: createSafeHttpClient(),
    getMemberRole: async (workspaceId, uid) => {
      if (!uid) return null;
      const m = await wsStore.getMember(workspaceId, uid);
      return m ? m.role : null;
    },
    appendAuditLog,
    logger,
  });
  const execSvc = executionService || require('./executions').executionService;
  execSvc.setConnectorGateway(service.gateway);
  return { router: createIntegrationsRouter({ workspaceService: wsSvc, integrationService: service, logger }), service, registry, encryptionConfigured: !keyRing.error };
}

module.exports = { createIntegrationsRouter, createIntegrationSystem };
