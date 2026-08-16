// backend/routes/hybrid.js

router.post('/:userId/execute-goal', async (req, res) => {
  try {
    const { userId } = req.params;
    const { goal } = req.body;

    // Stream response in real-time
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // === EXECUTE WITH TEACHING ===
    const orchestrator = require('../services/hybridOrchestrator');
    
    const stream = orchestrator.executeGoal(userId, goal);

    stream.on('step-complete', (data) => {
      res.write(`data: ${JSON.stringify({
        type: 'step-complete',
        step: data.step,
        output: data.output
      })}\n\n`);
    });

    stream.on('teaching-moment', (data) => {
      res.write(`data: ${JSON.stringify({
        type: 'teaching',
        whatHappened: data.whatHappened,
        whyThisApproach: data.whyThisApproach,
        patternToRemember: data.patternToRemember,
        challenge: data.challenge
      })}\n\n`);
    });

    stream.on('growth-update', (data) => {
      res.write(`data: ${JSON.stringify({
        type: 'growth',
        skillsGained: data.skillsGained,
        levelBefore: data.levelBefore,
        levelAfter: data.levelAfter
      })}\n\n`);
    });

    stream.on('complete', (data) => {
      res.write(`data: ${JSON.stringify({
        type: 'complete',
        result: data,
        nextChallenge: data.nextChallenge
      })}\n\n`);
      res.end();
    });

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

module.exports = router;