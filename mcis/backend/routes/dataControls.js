const express = require('express');
const router = express.Router();
const { exportUserData, deleteUserData } = require('../services/dataControlsService');
const logger = require('../services/logger');

router.get('/:userId/export', async (req, res) => {
  try {
    const data = await exportUserData(req.params.userId);
    res.json(data);
  } catch (err) {
    logger.error(`Data export error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not export user data' });
  }
});

router.delete('/:userId', async (req, res) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE') {
      return res.status(400).json({
        success: false,
        error: 'Type DELETE to confirm data deletion.',
      });
    }

    const result = await deleteUserData(req.params.userId);
    res.json(result);
  } catch (err) {
    logger.error(`Data delete error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not delete user data' });
  }
});

router.get('/privacy/summary', (req, res) => {
  res.json({
    success: true,
    summary: {
      product: 'MCIS uses memory, goals, files, projects, and preferences to personalize assistance.',
      controls: [
        'Users can view and delete individual memories.',
        'Users can export their stored data.',
        'Users can request deletion of app data.',
        'Users can choose their adaptive mode such as student, developer, founder, professional, or creator.',
      ],
      recommendation: 'Keep API keys and Firebase service accounts in environment variables only. Never commit secrets.',
    },
  });
});

module.exports = router;
