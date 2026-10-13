const express = require('express');
const router = express.Router();
const { triggerEmergencyStop, clearEmergencyStop } = require('../backend-routing/taskPlanner');
const { requireCaller } = require('../security-engine/callerIdentity');

// Exempt from the global Firebase middleware (the voice client's Ctrl+M /
// Ctrl+N hotkeys send X-Device-Token), so the caller is resolved here with
// the same rules as POST /api/command (Firebase token, voice-device
// secret -- including a rotation-window previous token, see
// callerIdentity.js -- or the existing dev-only bypass). Unauthenticated
// → 401. Before this fix these routes accepted ANY unauthenticated
// caller, letting an arbitrary outside request halt or resume automation
// for every user.
//
// P-SEC-3: the stop/resume used to be process-wide (ALL plans, for every
// caller) once any single authenticated caller triggered it -- including
// collapsing every voice-device-token holder into unrestricted global
// control. It is now scoped to the triggering caller's own principal
// (req.callerId, the exact identity taskPlanner already uses for plan
// ownership) -- it stops/resumes only that caller's own in-flight plans.
// It no longer reaches the separate, already workspace-scoped,
// owner/admin-only Layer 3/4 emergency stop (services/security's
// agentFirewall policy) either -- see taskPlanner.js's comment for why
// that cross-wiring was itself a cross-tenant bug.
router.post('/stop', requireCaller, (req, res) => {
  const result = triggerEmergencyStop(req.callerId);
  res.json({ success: true, message: 'Emergency stop activated — tumhara automation ruk gaya.', ...result });
});

router.post('/resume', requireCaller, (req, res) => {
  clearEmergencyStop(req.callerId);
  res.json({ success: true, message: 'Emergency stop cleared — automation dubara chalu ho sakta hai.' });
});

module.exports = router;
