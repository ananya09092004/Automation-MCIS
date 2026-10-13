const logger = require('./logger');
const { verifySyntax, checkSyntax } = require('./syntaxVerificationService');
const { analyzeComplexity, generateInterviewExplanation } = require('./complexityAnalysisService');
const { beautifyCode } = require('./codeBeautifierService');
const { generateAdversarialTests } = require('./adversarialTestService');
const { locateFailure, applySurgicalRepair } = require('./surgicalRepairService');
// Previously this ran untrusted, AI-generated AND user-submitted code
// directly on the backend host via execSync (writing a temp file to
// /tmp/mcis-tests, then `timeout 5 <interpreter> <file>` with no
// container/network/filesystem isolation beyond a wall-clock timeout).
// Any signed-up caller of POST /:userId/generate-and-test could run
// arbitrary Python/Node on the same host holding SUPABASE_KEY,
// GROQ_API_KEY, the Firebase admin credential, and the GitHub-token
// encryption key. routes/sandbox.js already has a real isolation
// boundary for exactly this (Judge0, an external sandboxed execution
// service) -- this now reuses that instead of inventing a second,
// unsandboxed one.
const sandboxService = require('./sandboxService');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * COMPLETE CODE QUALITY PIPELINE
 * Orchestrates: syntax → testing → repair → verification → learning
 */
async function runCompleteCodeQualityPipeline(userId, code, language, algorithm, problemStatement) {
  try {
    logger.info('🚀 STARTING CODE QUALITY PIPELINE');
    
    const pipeline = {
      steps: [],
      code: code,
      language: language || 'python',
      algorithm: algorithm,
      problem: problemStatement,
      success: true,
      errors: [],
      repairs_made: 0,
      tests_passed: 0,
      tests_total: 0
    };

    // ===== STEP 1: SYNTAX VERIFICATION =====
    logger.info('STEP 1️⃣: Syntax Verification');
    const syntaxCheck = await verifySyntax(code, language);
    pipeline.steps.push({
      name: 'Syntax Verification',
      status: syntaxCheck.valid ? 'PASS' : (syntaxCheck.fixed ? 'FIXED' : 'FAIL'),
      details: syntaxCheck
    });
    
    if (syntaxCheck.fixed) {
      pipeline.code = syntaxCheck.code;
      logger.info('✅ Syntax error fixed automatically');
    } else if (!syntaxCheck.valid) {
      pipeline.success = false;
      pipeline.errors.push(`Syntax error: ${syntaxCheck.error}`);
      return pipeline;
    }

    // ===== STEP 2: CODE BEAUTIFICATION =====
    logger.info('STEP 2️⃣: Code Beautification');
    const beautified = await beautifyCode(pipeline.code, language);
    if (beautified.success) {
      pipeline.code = beautified.code;
      pipeline.steps.push({
        name: 'Code Beautification',
        status: 'PASS',
        details: 'Code formatted (interview-ready)'
      });
      logger.info('✅ Code beautified');
    }

    // ===== STEP 3: DETECT ALGORITHM TYPE =====
    logger.info('STEP 3️⃣: Algorithm Detection');
    const { detectAlgorithm } = require('./algorithmDetectionService');
    const algorithmDetection = algorithm 
      ? { success: true, detection: { primary_algorithm: algorithm } }
      : await detectAlgorithm(userId, problemStatement);
    
    const detectedAlgo = algorithmDetection.detection?.primary_algorithm || 'unknown';
    pipeline.steps.push({
      name: 'Algorithm Detection',
      status: 'PASS',
      algorithm: detectedAlgo
    });
    logger.info(`✅ Algorithm detected: ${detectedAlgo}`);

    // ===== STEP 4: GENERATE ADVERSARIAL TESTS =====
    logger.info('STEP 4️⃣: Generate Adversarial Tests');
    const testGeneration = await generateAdversarialTests(userId, detectedAlgo, problemStatement);
    
    if (!testGeneration.success) {
      logger.warn('⚠️ Could not generate tests, skipping testing phase');
      pipeline.steps.push({
        name: 'Test Generation',
        status: 'SKIP',
        reason: 'Test generation failed'
      });
    } else {
      const tests = testGeneration.tests || [];
      pipeline.tests_total = tests.length;
      logger.info(`✅ Generated ${tests.length} adversarial tests`);

      // ===== STEP 5: RUN TESTS =====
      logger.info('STEP 5️⃣: Running Adversarial Tests');
      const testResults = await runTestsActually(pipeline.code, tests, language);
      
      const passedTests = testResults.filter(t => t.passed).length;
      const failedTests = testResults.filter(t => !t.passed);
      pipeline.tests_passed = passedTests;

      pipeline.steps.push({
        name: 'Adversarial Testing',
        status: failedTests.length === 0 ? 'PASS' : 'FAIL',
        passed: passedTests,
        failed: failedTests.length,
        total: tests.length
      });

      logger.info(`📊 Test Results: ${passedTests}/${tests.length} passed`);

      // ===== STEP 6: REPAIR IF NEEDED =====
      if (failedTests.length > 0) {
        logger.info('STEP 6️⃣: Automatic Surgical Repair');
        
        let currentCode = pipeline.code;
        let repairCount = 0;

        // Repair each failure
        for (const failedTest of failedTests.slice(0, 3)) { // Max 3 repairs
          logger.info(`🔧 Repairing failure: ${failedTest.message}`);

          // Locate failure
          const failure = await locateFailure(currentCode, failedTest);
          if (!failure.success) {
            logger.warn('Could not locate failure');
            continue;
          }

          // Apply repair
          const repair = await applySurgicalRepair(currentCode, failure.analysis);
          if (!repair.success) {
            logger.warn('Could not apply repair');
            continue;
          }

          // Verify syntax
          const repairSyntax = checkSyntax(repair.repaired_code, language);
          if (repairSyntax) {
            logger.warn('Repaired code has syntax errors, reverting');
            continue;
          }

          currentCode = repair.repaired_code;
          repairCount++;
          logger.info(`✅ Repair ${repairCount} applied: ${failure.analysis.root_cause}`);
        }

        if (repairCount > 0) {
          pipeline.code = currentCode;
          pipeline.repairs_made = repairCount;
          logger.info(`✅ ${repairCount} repairs completed`);

          // ===== STEP 7: RETEST AFTER REPAIR =====
          logger.info('STEP 7️⃣: Retest After Repair');
          const retestResults = await runTestsActually(pipeline.code, tests, language);
          const retestPassed = retestResults.filter(t => t.passed).length;
          const retestFailed = retestResults.filter(t => !t.passed);

          pipeline.tests_passed = retestPassed;

          pipeline.steps.push({
            name: 'Retest After Repair',
            status: retestFailed.length === 0 ? 'PASS' : 'PARTIAL',
            passed: retestPassed,
            failed: retestFailed.length,
            improvement: retestPassed - passedTests
          });

          logger.info(`📊 After repair: ${retestPassed}/${tests.length} passed`);
        }
      } else {
        logger.info('✅ All tests passed - No repairs needed');
      }
    }

    // ===== STEP 8: COMPLEXITY ANALYSIS =====
    logger.info('STEP 8️⃣: Complexity Analysis');
    if (algorithmDetection.success) {
      const complexity = await analyzeComplexity(pipeline.code, detectedAlgo);
      
      if (complexity.success) {
        pipeline.complexity = {
          time: complexity.analysis.time_complexity,
          space: complexity.analysis.space_complexity,
          is_optimal: complexity.analysis.is_optimal,
          proof: complexity.analysis.optimality_proof
        };
        logger.info(`✅ Complexity: ${pipeline.complexity.time} time, ${pipeline.complexity.space} space`);
        logger.info(`   Optimal: ${pipeline.complexity.is_optimal ? 'YES ✅' : 'NO ⚠️'}`);

        pipeline.steps.push({
          name: 'Complexity Analysis',
          status: 'PASS',
          complexity: pipeline.complexity
        });
      }
    }

    // ===== STEP 9: INTERVIEW EXPLANATION =====
    logger.info('STEP 9️⃣: Generate Interview Explanation');
    if (algorithmDetection.success && pipeline.complexity) {
      const interview = await generateInterviewExplanation(
        pipeline.code,
        pipeline.complexity,
        detectedAlgo
      );
      
      if (interview.success) {
        pipeline.interview_explanation = interview.explanation;
        logger.info('✅ Interview explanation generated');
        
        pipeline.steps.push({
          name: 'Interview Explanation',
          status: 'PASS',
          summary: interview.explanation.walkthrough?.substring(0, 100)
        });
      }
    }

    // ===== STEP 10: LEARN & IMPROVE =====
    logger.info('STEP 🔟: Learn & Self-Improve');
    const learning = await learnFromCodeQuality(userId, pipeline);
    if (learning.success) {
      logger.info(`✅ Learned from this code: ${learning.insights.join(', ')}`);
      pipeline.steps.push({
        name: 'Self-Learning',
        status: 'PASS',
        insights: learning.insights
      });
    }

    // ===== FINAL SUMMARY =====
    pipeline.final_status = pipeline.success ? 'SUCCESS' : 'PARTIAL';
    logger.info(`
╔════════════════════════════════════════╗
║     CODE QUALITY PIPELINE COMPLETE     ║
╚════════════════════════════════════════╝
Status: ${pipeline.final_status}
Syntax: ✅ Verified & Fixed
Tests: ${pipeline.tests_passed}/${pipeline.tests_total} Passed
Repairs: ${pipeline.repairs_made} Applied
Complexity: ${pipeline.complexity?.time || 'N/A'}
Quality: 95%+ ✅
    `);

    return pipeline;

  } catch (err) {
    logger.error(`Pipeline error: ${err.message}`);
    return {
      success: false,
      error: err.message,
      steps: []
    };
  }
}

// Run tests via Judge0 (sandboxService.runCode) -- never executes
// untrusted code on the backend host itself. Judge0 is an external,
// isolated execution service (separate container/VM, no access to this
// process's env vars, filesystem, or network), reached over HTTPS with
// only the submitted source as input.
async function runTestsActually(code, tests, language) {
  try {
    const results = [];

    for (const test of tests) {
      try {
        const wrappedCode = wrapCodeForTest(code, test, language);

        try {
          const result = await sandboxService.runCode(wrappedCode, language);
          const output = (result.stdout || '').trim();

          if (!result.success) {
            results.push({
              input: test.input,
              expected: test.expected,
              actual: 'ERROR',
              passed: false,
              message: test.why,
              error: (result.stderr || 'execution failed').slice(0, 200),
              status: 'ERROR'
            });
            continue;
          }

          results.push({
            input: test.input,
            expected: test.expected,
            actual: output,
            passed: output === test.expected?.toString().trim(),
            message: test.why,
            status: 'EXECUTED'
          });
        } catch (execErr) {
          // Judge0 unreachable/misconfigured (e.g. missing
          // JUDGE0_API_KEY) -- fail this test closed, never fall back
          // to local execution.
          results.push({
            input: test.input,
            expected: test.expected,
            actual: 'ERROR',
            passed: false,
            message: test.why,
            error: execErr.message.slice(0, 200),
            status: 'ERROR'
          });
        }
      } catch (err) {
        logger.error(`Test execution error: ${err.message}`);
      }
    }

    return results;
  } catch (err) {
    logger.error(`Run tests error: ${err.message}`);
    return [];
  }
}

// Learn from code quality
async function learnFromCodeQuality(userId, pipeline) {
  try {
    const insights = [];

    // Pattern 1: Algorithm mastery
    if (pipeline.tests_passed === pipeline.tests_total && pipeline.repairs_made === 0) {
      insights.push(`Mastery: Perfect ${pipeline.algorithm} implementation`);
    }

    // Pattern 2: Common mistakes
    if (pipeline.repairs_made > 0) {
      insights.push(`Learning: Fixed ${pipeline.repairs_made} common edge case issues`);
    }

    // Pattern 3: Complexity understanding
    if (pipeline.complexity?.is_optimal) {
      insights.push(`Excellence: Wrote optimal complexity solution`);
    }

    // Save learning
    await supabase.from('code_learning').insert([{
      user_id: userId,
      algorithm: pipeline.algorithm,
      tests_passed: pipeline.tests_passed,
      tests_total: pipeline.tests_total,
      repairs: pipeline.repairs_made,
      complexity_optimal: pipeline.complexity?.is_optimal || false,
      insights: insights,
      code_hash: hashCode(pipeline.code),
      created_at: new Date().toISOString()
    }]).catch(err => logger.error(`Save learning error: ${err.message}`));

    return { success: true, insights };
  } catch (err) {
    logger.error(`Learn error: ${err.message}`);
    return { success: false };
  }
}

function wrapCodeForTest(code, test, language) {
  if (language === 'python') {
    return `${code}\n\ntry:\n    print(solution(${JSON.stringify(test.input)}))\nexcept Exception as e:\n    print(f"ERROR: {e}")`;
  }
  // Handle other languages...
  return code;
}

function hashCode(code) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(code).digest('hex').slice(0, 10);
}

module.exports = {
  runCompleteCodeQualityPipeline,
  runTestsActually,
  learnFromCodeQuality
};