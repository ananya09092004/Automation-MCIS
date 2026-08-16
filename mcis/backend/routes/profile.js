const express = require('express');
const router = express.Router();
const { getUserDeepProfile, analyzeUserFromMessages } = require('../services/userDeepProfileService');
const { predictUserBehavior } = require('../services/behaviorAnalyzerService');
const { getGrowthTrajectory, generateTimelineNarrative } = require('../services/lifeTimelineService');
const { ROLE_CONFIG, getAdaptiveProfile, saveAdaptiveProfile } = require('../services/adaptiveProfileService');
const logger = require('../services/logger');

// Get user profile
router.get('/:userId/profile', async (req, res) => {
  try {
    const profile = await getUserDeepProfile(req.params.userId);
    res.json({ success: true, profile: profile || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get role-based adaptive profile for product personalization
router.get('/:userId/adaptive', async (req, res) => {
  try {
    const profile = await getAdaptiveProfile(req.params.userId);
    res.json({
      success: true,
      profile,
      roles: Object.entries(ROLE_CONFIG).map(([id, config]) => ({
        id,
        label: config.label,
        promise: config.promise,
        dailyFocus: config.dailyFocus,
      })),
    });
  } catch (err) {
    logger.error(`Adaptive profile get error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save role-based adaptive profile
router.put('/:userId/adaptive', async (req, res) => {
  try {
    const profile = await saveAdaptiveProfile(req.params.userId, req.body || {});
    res.json({ success: true, profile });
  } catch (err) {
    logger.error(`Adaptive profile save error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Analyze user from recent messages
router.post('/:userId/analyze', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || messages.length === 0) {
      return res.json({ success: false, message: 'No messages to analyze' });
    }

    const result = await analyzeUserFromMessages(req.params.userId, messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get behavior prediction
router.get('/:userId/behavior-prediction', async (req, res) => {
  try {
    const prediction = await predictUserBehavior(req.params.userId);
    res.json({ success: true, prediction: prediction || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get growth trajectory
router.get('/:userId/trajectory', async (req, res) => {
  try {
    const trajectory = await getGrowthTrajectory(req.params.userId);
    res.json(trajectory);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get timeline narrative
router.get('/:userId/narrative', async (req, res) => {
  try {
    const narrative = await generateTimelineNarrative(req.params.userId);
    res.json({ success: true, narrative });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
