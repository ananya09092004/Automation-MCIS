const express = require('express');
const router = express.Router();
const { grantPermission } = require('../security-engine/permissions');
const { resumePlanAsync } = require('../backend-routing/taskPlanner');
const { requireCaller } = require('../security-engine/callerIdentity');

// Exempt from the global Firebase middleware (the voice client sends
// X-Device-Token, not a Firebase token), so the caller is resolved here
// with the same rules as POST /api/command (Firebase token, voice-device
// secret -- including a rotation-window previous token, see
// callerIdentity.js -- or the existing dev-only bypass). Unauthenticated
// → 401. Previously this used a hardcoded userId and nothing else,
// meaning ANY caller who knew or guessed a planId could resume another
// user's paused/awaiting-approval plan with zero real authorization.
router.post('/grant', requireCaller, async (req, res) => {
  const userId = req.callerId;
  const { resource } = req.body || {};

  if (!resource || typeof resource !== 'string') {
    return res.status(400).json({ error: 'resource required' });
  }

  try {
    if (resource.startsWith('plan:')) {
      const planId = resource.replace('plan:', '');
      // Non-blocking: returns immediately, client polls
      // GET /api/command/goal/:planId/status for progress/completion.
      // Only the plan's owner can resume it, and only while it is paused
      // -- resumePlanAsync itself verifies planId belongs to userId via
      // taskPlanner.js's getOwnedPlan() before resuming anything.
      const result = resumePlanAsync(planId, userId);
      if (result.code === 'PLAN_NOT_FOUND') return res.status(404).json(result);
      if (result.code === 'PLAN_NOT_PAUSED') return res.status(409).json(result);
      return res.json(result);
    }

    const result = await grantPermission(userId, resource);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
