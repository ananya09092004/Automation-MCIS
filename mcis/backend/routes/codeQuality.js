const express = require('express');
const router = express.Router();
const logger = require('../services/logger');

const { verifySyntax } = require('../services/syntaxVerificationService');
const { analyzeComplexity, generateInterviewExplanation } = require('../services/complexityAnalysisService');
const { beautifyCode } = require('../services/codeBeautifierService');

// ENDPOINT 1: Verify syntax and fix if needed
router.post('/:userId/verify-syntax', async (req, res) => {
  try {
    const { code, language } = req.body;
    
    const result = await verifySyntax(code, language || 'python');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ENDPOINT 2: Deep complexity analysis
router.post('/:userId/analyze-complexity', async (req, res) => {
  try {
    const { code, algorithm } = req.body;
    
    if (!code || !algorithm) {
      return res.status(400).json({ success: false, error: 'Code and algorithm required' });
    }

    const result = await analyzeComplexity(code, algorithm);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ENDPOINT 3: Generate interview explanation
router.post('/:userId/interview-explanation', async (req, res) => {
  try {
    const { code, algorithm, complexity } = req.body;
    
    if (!code || !algorithm || !complexity) {
      return res.status(400).json({ success: false, error: 'Code, algorithm, and complexity required' });
    }

    const result = await generateInterviewExplanation(code, complexity, algorithm);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ENDPOINT 4: Beautify code
router.post('/:userId/beautify', async (req, res) => {
  try {
    const { code, language } = req.body;
    
    const result = await beautifyCode(code, language || 'python');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ENDPOINT 5: Complete code quality check
router.post('/:userId/quality-check', async (req, res) => {
  try {
    const { code, language, algorithm } = req.body;

    // Step 1: Verify syntax
    const syntaxCheck = await verifySyntax(code, language || 'python');
    if (!syntaxCheck.success) {
      return res.json(syntaxCheck);
    }

    // Step 2: Beautify
    const beautified = await beautifyCode(syntaxCheck.code, language || 'python');

    // Step 3: Analyze complexity
    const complexity = algorithm 
      ? await analyzeComplexity(beautified.code, algorithm)
      : null;

    // Step 4: Generate interview explanation
    const interview = (complexity && algorithm)
      ? await generateInterviewExplanation(beautified.code, complexity.analysis, algorithm)
      : null;

    res.json({
      success: true,
      syntax: syntaxCheck,
      beautified: beautified.code,
      complexity: complexity?.analysis || null,
      interview_explanation: interview?.explanation || null,
      ready_for_submission: syntaxCheck.valid && !syntaxCheck.errors.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;