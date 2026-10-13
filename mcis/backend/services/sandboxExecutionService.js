// backend/services/sandboxExecutionService.js
//
// Previously this executed user-submitted code directly on the backend
// host via execSync (no container/network/filesystem isolation beyond
// a 5s wall-clock timeout) -- the same unsandboxed-RCE pattern fixed in
// codeQualityPipelineService.js. This module was never actually
// `require()`d anywhere in the backend (confirmed by a repo-wide
// search), so it posed no live exploitable path, but leaving a
// ready-to-wire RCE primitive sitting in the codebase is its own risk
// if something imports it later without re-discovering why that's
// unsafe. It now delegates to the same Judge0-backed sandbox
// (services/sandboxService.js) routes/sandbox.js already uses, so if
// anything wires this module in going forward, it inherits real
// isolation rather than host execution.
const logger = require('./logger');
const sandboxService = require('./sandboxService');

async function executeCode(code, testInput, language = 'python') {
  try {
    const wrappedCode = wrapCode(code, testInput, language);
    const result = await sandboxService.runCode(wrappedCode, language);
    if (!result.success) {
      return { success: false, error: result.stderr || 'execution failed' };
    }
    return { success: true, output: result.stdout };
  } catch (err) {
    logger.error(`Execution error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Run multiple test cases
async function runTestSuite(code, testCases, language = 'python') {
  try {
    const results = [];

    for (const test of testCases) {
      const result = await executeCode(code, test, language);

      results.push({
        input: test.input,
        expected: test.expected,
        actual: result.output || '',
        passed: result.output?.trim() === test.expected?.toString().trim(),
        status: result.success ? 'SUCCESS' : 'ERROR'
      });
    }

    const passCount = results.filter(r => r.passed).length;
    const passRate = (passCount / results.length) * 100;

    return {
      success: true,
      results,
      pass_rate: passRate,
      summary: `${passCount}/${results.length} tests passed`
    };
  } catch (err) {
    logger.error(`Test suite error: ${err.message}`);
    return { success: false };
  }
}

function wrapCode(code, testInput, language) {
  if (language === 'python') {
    return `${code}\n\nprint(solution(${JSON.stringify(testInput)}))`;
  }
  // ... wrap for other languages
  return code;
}

module.exports = {
  executeCode,
  runTestSuite
};
