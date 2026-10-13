const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

const { initializeDigitalTwin, getUserDigitalTwin, updateTwinConfidence, getTwinSummary } = require('../services/digitalTwinService');
const { predictUserBehavior, predictStressRisk, predictTaskCompletion } = require('../services/behaviorPredictionService');
const { recordPredictionOutcome, getTwinLearningHistory, getTwinAccuracyStats } = require('../services/twinLearningService');
const { generateAdaptation, applyAdaptation, getAdaptationHistory } = require('../services/twinAdaptationService');

// Initialize twin
router.post('/:userId/initialize', async (req, res) => {
  try {
    const { userData } = req.body;
    const result = await initializeDigitalTwin(req.params.userId, userData || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get twin model
router.get('/:userId', async (req, res) => {
  try {
    const twin = await getUserDigitalTwin(req.params.userId);
    res.json({ success: true, twin: twin || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get twin summary (for chat)
router.get('/:userId/summary', async (req, res) => {
  try {
    const summary = await getTwinSummary(req.params.userId);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Predict behavior
router.post('/:userId/predict-behavior', async (req, res) => {
  try {
    const twin = await getUserDigitalTwin(req.params.userId);
    if (!twin) return res.status(404).json({ success: false, error: 'Twin not found' });

    const result = await predictUserBehavior(req.params.userId, twin, req.body.context || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Predict stress risk
router.post('/:userId/predict-stress', async (req, res) => {
  try {
    const twin = await getUserDigitalTwin(req.params.userId);
    if (!twin) return res.status(404).json({ success: false, error: 'Twin not found' });

    const result = await predictStressRisk(req.params.userId, twin, req.body.activity || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Predict task completion
router.post('/:userId/predict-task', async (req, res) => {
  try {
    const twin = await getUserDigitalTwin(req.params.userId);
    if (!twin) return res.status(404).json({ success: false, error: 'Twin not found' });

    const result = await predictTaskCompletion(req.params.userId, twin, req.body.task || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Record prediction outcome
router.post('/:userId/record-outcome/:predictionId', async (req, res) => {
  try {
    const { actual_outcome, feedback } = req.body;
    const result = await recordPredictionOutcome(
      req.params.userId,
      req.params.predictionId,
      actual_outcome,
      feedback || ''
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get learning history
router.get('/:userId/learning-history', async (req, res) => {
  try {
    const result = await getTwinLearningHistory(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get accuracy stats
router.get('/:userId/accuracy-stats', async (req, res) => {
  try {
    const result = await getTwinAccuracyStats(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate adaptation
router.post('/:userId/generate-adaptation', async (req, res) => {
  try {
    const twin = await getUserDigitalTwin(req.params.userId);
    if (!twin) return res.status(404).json({ success: false, error: 'Twin not found' });

    const result = await generateAdaptation(req.params.userId, twin, req.body.performance || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Apply adaptation
router.post('/:userId/apply-adaptation', async (req, res) => {
  try {
    const { adaptation, system_component } = req.body;
    const result = await applyAdaptation(req.params.userId, adaptation || {}, system_component);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get adaptation history
router.get('/:userId/adaptations', async (req, res) => {
  try {
    const result = await getAdaptationHistory(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;