// backend/routes/github.js

const express       = require('express');
const router        = express.Router();
const githubService = require('../services/githubService');
const { createClient } = require('@supabase/supabase-js');
const logger        = require('../services/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ─── GET /api/github/connect/:userId ─────────────────────────────────────────
router.get('/connect/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const url = githubService.getOAuthURL(userId);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/github/callback ────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');
    const result = await githubService.exchangeCodeForToken(code, state);
    res.redirect(`${FRONTEND_URL}/settings?github=connected&username=${result.username}`);
  } catch (err) {
    logger.error(`GitHub callback error: ${err.message}`);
    res.redirect(`${FRONTEND_URL}/settings?github=error`);
  }
});

// ─── GET /api/github/status/:userId ──────────────────────────────────────────
router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const integration = await githubService.getUserToken(userId);
    res.json({
      connected: !!integration,
      username:  integration?.github_username || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/github/disconnect/:userId ───────────────────────────────────
router.delete('/disconnect/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { error } = await supabase
      .from('user_integrations')
      .update({ github_token: null, github_username: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw error;
    res.json({ success: true, message: 'GitHub disconnected' });
  } catch (err) {
    logger.error(`GitHub disconnect error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/github/push ───────────────────────────────────────────────────
router.post('/push', async (req, res) => {
  try {
    const { userId, repoName, description, files } = req.body;
    if (!userId || !repoName || !files?.length) {
      return res.status(400).json({ error: 'userId, repoName, files required' });
    }
    const result = await githubService.createRepoAndPush(userId, { repoName, description, files });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`GitHub push error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;