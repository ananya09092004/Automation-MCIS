const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

const { getCodingProfile, updateCodingProfile } = require('../services/codingProfileService');
const { detectAlgorithm } = require('../services/algorithmDetectionService');
const { generateAdversarialTests, runTests } = require('../services/adversarialTestService');
const { locateFailure, applySurgicalRepair } = require('../services/surgicalRepairService');

// INNOVATION 1: Get personalized code generation settings
router.get('/:userId/profile', async (req, res) => {
  try {
    const profile = await getCodingProfile(req.params.userId);
    res.json({ success: true, profile: profile || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// INNOVATION 2: Detect algorithm
router.post('/:userId/detect-algorithm', async (req, res) => {
  try {
    const { problem } = req.body;
    if (!problem) {
      return res.status(400).json({ success: false, error: 'Problem statement required' });
    }

    const result = await detectAlgorithm(req.params.userId, problem);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// INNOVATION 2: Generate adversarial tests
router.post('/:userId/generate-tests', async (req, res) => {
  try {
    const { algorithm, problem } = req.body;
    if (!algorithm || !problem) {
      return res.status(400).json({ success: false, error: 'Algorithm and problem required' });
    }

    const result = await generateAdversarialTests(req.params.userId, algorithm, problem);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// INNOVATION 3: Locate and repair failure
router.post('/:userId/repair-code', async (req, res) => {
  try {
    const { code, failing_test } = req.body;
    if (!code || !failing_test) {
      return res.status(400).json({ success: false, error: 'Code and test required' });
    }

    // Step 1: Locate failure
    const analysis = await locateFailure(code, failing_test);
    if (!analysis.success) {
      return res.json(analysis);
    }

    // Step 2: Apply surgical repair
    const repair = await applySurgicalRepair(code, analysis.analysis);
    
    res.json({
      success: true,
      analysis: analysis.analysis,
      repaired_code: repair.repaired_code,
      explanation: analysis.analysis.explanation
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;