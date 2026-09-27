// backend/routes/github.js
//
// Legacy per-user GitHub connection. Same URLs and response shapes as
// before; Layer 6 moved storage to the encrypted integration store and
// replaced the guessable state (see services/githubService.js).
//
//   GET    /api/github/connect/:userId     → { success, url }       (auth; :userId must be the caller)
//   GET    /api/github/callback            → redirect to the frontend  (public; the single-use state is the binding)
//   GET    /api/github/status/:userId      → { connected, username }
//   DELETE /api/github/disconnect/:userId  → { success, message }
//   POST   /api/github/push                → push files to the CALLER's GitHub (body.userId, if sent, must be the caller)

const express = require('express');
const logger = require('../services/logger');

function createGithubRouter({ githubService = require('../services/githubService'), frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000' } = {}) {
  const router = express.Router();
  const safeStatus = (err) => (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500);
  const safeMessage = (err, fallback) => (err && err.status && err.status < 500 ? err.message : fallback);
  // The auth middleware already rejects a :userId that is not the caller;
  // this keeps the check local too (defence in depth).
  const callerOnly = (req, res) => {
    if (req.user && req.user.uid && req.params.userId !== req.user.uid) {
      res.status(403).json({ success: false, error: 'Forbidden for this user' });
      return false;
    }
    return true;
  };

  router.get('/connect/:userId', async (req, res) => {
    if (!callerOnly(req, res)) return;
    try {
      const url = await githubService.getOAuthURL(req.params.userId);
      res.json({ success: true, url });
    } catch (err) {
      logger.error(`GitHub connect error: ${err.code || 'error'}`);
      res.status(safeStatus(err)).json({ success: false, error: safeMessage(err, 'Could not start the GitHub connection.') });
    }
  });

  router.get('/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) return res.redirect(`${frontendUrl}/settings?github=error`);
    // Workspace-level connections are completed by an AUTHENTICATED request
    // from the frontend (the caller must be the user the state was issued
    // to). Code/state go in the URL fragment, which is never sent to a server.
    if (state.startsWith('w.')) {
      return res.redirect(`${frontendUrl}/security#oauth=github&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    }
    try {
      const result = await githubService.exchangeCodeForToken(code, state);
      return res.redirect(`${frontendUrl}/settings?github=connected&username=${encodeURIComponent(result.username)}`);
    } catch (err) {
      // No details (state validity, GitHub errors, tokens) leave the server.
      logger.warn(`GitHub callback rejected: ${err.code || 'error'}`);
      return res.redirect(`${frontendUrl}/settings?github=error`);
    }
  });

  router.get('/status/:userId', async (req, res) => {
    if (!callerOnly(req, res)) return;
    try {
      const s = await githubService.getStatus(req.params.userId);
      res.json({ connected: !!s.connected, username: s.username || null });
    } catch (err) {
      logger.error(`GitHub status error: ${err.code || 'error'}`);
      res.status(500).json({ success: false, error: 'Could not read the GitHub connection status.' });
    }
  });

  router.delete('/disconnect/:userId', async (req, res) => {
    if (!callerOnly(req, res)) return;
    try {
      await githubService.disconnect(req.params.userId);
      res.json({ success: true, message: 'GitHub disconnected' });
    } catch (err) {
      logger.error(`GitHub disconnect error: ${err.code || 'error'}`);
      res.status(500).json({ success: false, error: 'Could not disconnect GitHub.' });
    }
  });

  router.post('/push', async (req, res) => {
    try {
      const { userId, repoName, description, files } = req.body || {};
      // Previously the target account came from body.userId — any signed-in
      // user could push with someone else's token. It is now the caller.
      const caller = req.user && req.user.uid;
      if (!caller) return res.status(401).json({ success: false, error: 'Authentication required' });
      if (userId !== undefined && userId !== caller) return res.status(403).json({ success: false, error: 'Forbidden for this user' });
      if (!repoName || !Array.isArray(files) || !files.length) {
        return res.status(400).json({ error: 'repoName, files required' });
      }
      const result = await githubService.createRepoAndPush(caller, { repoName, description, files });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error(`GitHub push error: ${err.code || 'error'}`);
      res.status(500).json({ success: false, error: String(err.message || 'GitHub push failed').slice(0, 200) });
    }
  });

  return router;
}

module.exports = createGithubRouter();
module.exports.createGithubRouter = createGithubRouter;
