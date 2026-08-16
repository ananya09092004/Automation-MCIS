const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Execute code in sandboxed environment
async function executeCode(code, testInput, language = 'python') {
  try {
    // Create temporary file
    const tempDir = '/tmp/mcis-sandbox';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fileName = path.join(tempDir, `test_${Date.now()}.${getExtension(language)}`);
    
    // Prepare code with test
    const wrappedCode = wrapCode(code, testInput, language);
    fs.writeFileSync(fileName, wrappedCode);

    // Execute with timeout
    const result = execSync(`timeout 5 ${getCommand(language)} ${fileName}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 1024 * 1024
    });

    // Clean up
    fs.unlinkSync(fileName);

    return { success: true, output: result };
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

function getExtension(language) {
  const ext = {
    python: 'py',
    javascript: 'js',
    java: 'java',
    cpp: 'cpp'
  };
  return ext[language] || 'py';
}

function getCommand(language) {
  const cmd = {
    python: 'python3',
    javascript: 'node',
    java: 'java',
    cpp: 'g++'
  };
  return cmd[language] || 'python3';
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