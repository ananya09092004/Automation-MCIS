const express = require('express');
const router = express.Router();
const { triggerEmergencyStop, clearEmergencyStop } = require('../backend-routing/taskPlanner');

router.post('/stop', (req, res) => {
  const result = triggerEmergencyStop();
  res.json({ success: true, message: 'Emergency stop activated — sab automation ruk gaya.', ...result });
});

router.post('/resume', (req, res) => {
  clearEmergencyStop();
  res.json({ success: true, message: 'Emergency stop cleared — automation dubara chalu ho sakta hai.' });
});

module.exports = router;