const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { runCompleteCodeQualityPipeline } = require('../services/codeQualityPipelineService');

// Complete code quality pipeline endpoint
router.post('/:userId/generate-and-test', async (req, res) => {
  try {
    const { userId } = req.params;
    const { code, language, algorithm, problem } = req.body;

    if (!code || !problem) {
      return res.status(400).json({ 
        success: false, 
        error: 'Code and problem statement required' 
      });
    }

    logger.info(`🚀 Starting complete pipeline for ${userId}`);

    // Run the complete pipeline
    const result = await runCompleteCodeQualityPipeline(
      userId,
      code,
      language || 'python',
      algorithm,
      problem
    );

    res.json({
      success: result.success,
      final_code: result.code,
      complexity: result.complexity,
      interview_explanation: result.interview_explanation,
      tests_passed: result.tests_passed,
      tests_total: result.tests_total,
      repairs_made: result.repairs_made,
      steps: result.steps,
      ready_for_interview: result.tests_passed === result.tests_total && result.repairs_made === 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;