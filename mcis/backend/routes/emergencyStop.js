const express = require('express');
const router = express.Router();
const { triggerEmergencyStop, clearEmergencyStop } = require('../backend-routing/taskPlanner');
const { requireCaller } = require('../security-engine/callerIdentity');

// Exempt from the global Firebase middleware (the voice client's Ctrl+M /
// Ctrl+N hotkeys send X-Device-Token), so the caller is resolved here with
// the same rules as POST /api/command. Unauthenticated → 401.
// NOTE: the stop itself is still process-wide (all plans), as before —
// per-user/per-workspace scoping is later-layer work.
router.post('/stop', requireCaller, (req, res) => {
  const result = triggerEmergencyStop();
  res.json({ success: true, message: 'Emergency stop activated — sab automation ruk gaya.', ...result });
});

router.post('/resume', requireCaller, (req, res) => {
  clearEmergencyStop();
  res.json({ success: true, message: 'Emergency stop cleared — automation dubara chalu ho sakta hai.' });
});

module.exports = router;
