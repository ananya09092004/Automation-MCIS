const express = require('express');
const router = express.Router();
const { createDecisionSimulation, getSimulatedFutures } = require('../services/futureSimulatorService');
const { predictTrajectory, predictCompletionDate, identifyPotentialObstacles } = require('../services/trajectoryPredictorService');
const { generateRecommendation, saveRecommendation } = require('../services/decisionRecommenderService');
const { getUserDeepProfile } = require('../services/userDeepProfileService');
const logger = require('../services/logger');

// Simulate decision futures
router.post('/:userId/simulate', async (req, res) => {
  try {
    const { userId } = req.params;
    const { decision, context } = req.body;

    if (!decision) {
      return res.status(400).json({ success: false, error: 'Decision required' });
    }

    const result = await createDecisionSimulation(userId, decision, context || {});
    
    if (result.success) {
      // Generate recommendation
      const profile = await getUserDeepProfile(userId);
      const recommendation = await generateRecommendation(
        result.futures,
        profile || {},
        []
      );

      if (recommendation.success) {
        await saveRecommendation(userId, result.simulation_id, recommendation.recommendation);
      }

      res.json({
        success: true,
        simulation_id: result.simulation_id,
        futures: result.futures,
        recommendation: recommendation.recommendation
      });
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get simulated futures
router.get('/simulations/:simulationId', async (req, res) => {
  try {
    const result = await getSimulatedFutures(req.params.simulationId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Predict trajectory
router.post('/:userId/predict-trajectory', async (req, res) => {
  try {
    const { goal, current_progress } = req.body;

    if (!goal) {
      return res.status(400).json({ success: false, error: 'Goal required' });
    }

    const result = await predictTrajectory(req.params.userId, goal, current_progress || 0);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Predict completion date
router.post('/:userId/predict-completion', async (req, res) => {
  try {
    const { goal, current_progress, user_capacity } = req.body;

    const result = await predictCompletionDate(
      goal,
      current_progress || 0,
      user_capacity || 10
    );
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Identify obstacles
router.post('/:userId/obstacles', async (req, res) => {
  try {
    const { goal, context } = req.body;

    if (!goal) {
      return res.status(400).json({ success: false, error: 'Goal required' });
    }

    const result = await identifyPotentialObstacles(req.params.userId, goal, context || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;