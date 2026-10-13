const express = require('express');
const router = express.Router();
const { runDailyProactive } = require('../jobs/dailyProactive');
const logger = require('../services/logger');

// Daily proactive job
router.post('/daily-proactive', async (req, res) => {
  try {
    logger.info('Daily proactive job started');
    await runDailyProactive();
    res.json({ success: true, message: 'Daily proactive job completed' });
  } catch (err) {
    logger.error(`Daily proactive job error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;