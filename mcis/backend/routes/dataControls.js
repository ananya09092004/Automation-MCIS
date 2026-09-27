const express = require('express');
const router = express.Router();
const { exportUserData, deleteUserData } = require('../services/dataControlsService');
const logger = require('../services/logger');
const { appendAuditLog } = require('../security-engine/auditLog');

// Layer 9: data exports and erasures are audited (counts only, never data).
function audit(userId, action, payload, success, error = null) {
  try { Promise.resolve(appendAuditLog(userId, action, payload, { success, error })).catch(() => {}); } catch { /* never breaks the request */ }
}

router.get('/:userId/export', async (req, res) => {
  try {
    const data = await exportUserData(req.params.userId);
    audit(req.params.userId, 'data_exported', {
      tables: Object.keys(data.tables).length, rows: Object.values(data.tables).reduce((a, r) => a + r.length, 0), skipped: data.skippedTables.length,
    }, true);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    audit(req.params.userId, 'data_exported', {}, false, 'EXPORT_FAILED');
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
    audit(req.params.userId, 'data_deleted', {
      tables: result.results.filter((r) => r.deleted).length, skipped: result.results.filter((r) => !r.deleted).length,
    }, true);
    res.json(result);
  } catch (err) {
    audit(req.params.userId, 'data_deleted', {}, false, 'DELETE_FAILED');
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
