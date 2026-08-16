// backend/routes/sandbox.js

const express   = require('express');
const router    = express.Router();
const sandbox   = require('../services/sandboxService');
const logger    = require('../services/logger');

// ─── POST /api/sandbox/:userId/execute ───────────────────────────────────────
// Body: { goal, language, teachMode }
// Streams SSE events back to frontend
router.post('/:userId/execute', async (req, res) => {
  const { userId }                           = req.params;
  const { goal, language = 'javascript', teachMode = false } = req.body;

  if (!goal) return res.status(400).json({ error: 'goal is required' });

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await sandbox.executeWithHealing({
      goal,
      language,
      teachMode,
      maxAttempts: 5,
      onProgress: (event) => send(event),
    });

    send({ type: 'complete', result });
  } catch (err) {
    logger.error(`Sandbox error for ${userId}: ${err.message}`);
    send({ type: 'fatal_error', error: err.message });
  } finally {
    res.end();
  }
});

// ─── POST /api/sandbox/:userId/run-only ──────────────────────────────────────
// Just run code — no generation, no healing
// Body: { code, language }
router.post('/:userId/run-only', async (req, res) => {
  const { code, language = 'javascript' } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    const result = await sandbox.runCode(code, language);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;