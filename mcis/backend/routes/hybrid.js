// backend/routes/hybrid.js
//
// Was broken: `router` was used with no `express`/`express.Router()`
// import anywhere in the file (ReferenceError on load), and it called
// `orchestrator.executeGoal(...)` — a shared module.exports singleton —
// as if it synchronously returned an EventEmitter, with no 'error'
// listener wired up. Fixed below: real router, a fresh orchestrator
// instance per request (see hybridOrchestrator.js for why), and an
// 'error' listener so failures reach the client instead of hanging the
// SSE stream open forever.

const express = require('express');
const router = express.Router();
const HybridOrchestrator = require('../services/hybridOrchestrator');

router.post('/:userId/execute-goal', async (req, res) => {
  const { userId } = req.params;
  const { goal } = req.body;

  if (!goal) {
    return res.status(400).json({ error: 'goal required' });
  }

  // Stream response in real-time
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const orchestrator = new HybridOrchestrator();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  orchestrator.on('step-complete', (data) => {
    send('step-complete', { step: data.step, output: data.output });
  });

  orchestrator.on('teaching-moment', (data) => {
    send('teaching', {
      whatHappened: data.whatHappened,
      whyThisApproach: data.whyThisApproach,
      patternToRemember: data.patternToRemember,
      challenge: data.challenge,
    });
  });

  orchestrator.on('growth-update', (data) => {
    send('growth', {
      skillsGained: data.skillsGained,
      levelBefore: data.levelBefore,
      levelAfter: data.levelAfter,
    });
  });

  orchestrator.on('complete', (data) => {
    send('complete', { result: data, nextChallenge: data.nextChallenge });
    res.end();
  });

  orchestrator.on('error', (data) => {
    send('error', { error: data.message || 'Unknown error' });
    res.end();
  });

  // Client disconnected early — stop listening, nothing left to write to.
  req.on('close', () => {
    orchestrator.removeAllListeners();
  });

  orchestrator.executeGoal(userId, goal);
});

module.exports = router;
