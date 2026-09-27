/**
 * Layer 9 — public OAuth redirect endpoints for WORKSPACE connections.
 *
 *   GET /api/oauth/google_drive/callback?code=&state=
 *     → 302 to <FRONTEND_URL>/security#oauth=google_drive&code=…&state=…
 *
 * Nothing is exchanged here: the fragment is never sent to any server, and
 * the app completes the connection with an AUTHENTICATED request whose
 * caller must be the owner the single-use state was issued to (Layer 6
 * workspace_connect binding). Only workspace states ("w.") are forwarded.
 */
'use strict';

const express = require('express');

const STATE_RE = /^w\.[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9._~/-]{8,512}$/;

function createOAuthCallbackRouter({ frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000' } = {}) {
  const router = express.Router();
  const base = String(frontendUrl).replace(/\/+$/, '');
  router.get('/google_drive/callback', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!CODE_RE.test(code) || !STATE_RE.test(state)) return res.redirect(`${base}/security#oauth=google_drive&error=1`);
    return res.redirect(`${base}/security#oauth=google_drive&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  });
  return router;
}

module.exports = { createOAuthCallbackRouter };
