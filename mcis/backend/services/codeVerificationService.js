// backend/services/codeVerificationService.js
//
// SECURITY: runScript() previously compiled/ran AI-generated verification
// harnesses (themselves built from vision-extracted, i.e. user-supplied,
// code via routes/image.js) directly on the backend host with execFile --
// including compiling and executing a native C/C++ binary. Same
// unsandboxed-RCE class fixed in codeQualityPipelineService.js. Now
// delegates to services/sandboxService.js (Judge0, an external isolated
// execution service), the same boundary routes/sandbox.js already uses.

const Groq = require('groq-sdk');
const crypto = require('crypto');
const logger = require('./logger');
const sandboxService = require('./sandboxService');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Render pe ye sab already installed hain (confirmed via /check-runtimes)
const SUPPORTED_LANGUAGES = {
  javascript: 'javascript',
  js:         'javascript',
  node:       'javascript',
  nodejs:     'javascript',
  python:     'python',
  python3:    'python',
  py:         'python',
  'c++':      'cpp',
  cpp:        'cpp',
  c:          'c',
};

function normalizeLanguage(language) {
  return SUPPORTED_LANGUAGES[(language || '').toLowerCase().trim()] || null;
}

// ─── STEP 1 — Vision response se code + test cases + constraints + language nikalo ───
async function extractCodeAndTests(visionResponse) {
  const prompt = `
You are analyzing an AI's response to a coding problem screenshot.
Below is the FULL response text (problem statement, constraints, example test cases, and a solution).

Extract and return ONLY a valid JSON object (no markdown, no backticks) with this exact shape:
{
  "language": "javascript" | "python" | "cpp" | "c" | "other",
  "code": "the solution code, as a plain string, exactly as given",
  "testCases": [ { "input": "description or literal input", "expectedOutput": "expected output" } ],
  "constraints": "constraints text, or empty string if none"
}

Rules:
- "language" must be normalized: C++ → "cpp", Python → "python", JavaScript/Node → "javascript", C → "c".
- If you cannot find clear example test cases (inputs and expected outputs), return an empty array for testCases.
- If no code block exists, return "code": "".

Response to analyze:
"""
${visionResponse.slice(0, 6000)}
"""
`;

  const completion = await groq.chat.completions.create({
    model: 'qwen/qwen3.6-27b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 2048,
  });

  let raw = completion.choices[0].message.content.trim();
  raw = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    logger.error(`[VERIFY] Extraction JSON parse failed: ${e.message}`);
    return { language: 'other', code: '', testCases: [], constraints: '' };
  }
}

// ─── STEP 2 — Language-specific runnable test script banao (via Groq) ───
async function buildTestScript(language, code, testCases, constraints) {
  const langInstructions = {
    javascript: {
      label: 'Node.js (JavaScript)',
      passMarker: 'ALL_TESTS_PASSED',
      failMarker: 'TEST_FAILED:',
      example: `On success: console.log("ALL_TESTS_PASSED"); process.exit(0);
On first failure: console.log("TEST_FAILED: <reason>"); process.exit(1);`,
    },
    python: {
      label: 'Python 3',
      passMarker: 'ALL_TESTS_PASSED',
      failMarker: 'TEST_FAILED:',
      example: `On success: print("ALL_TESTS_PASSED"); sys.exit(0)
On first failure: print("TEST_FAILED: <reason>"); sys.exit(1)
Wrap everything in try/except so exceptions also print TEST_FAILED: <error> and exit(1).`,
    },
    cpp: {
      label: 'C++ (g++, C++17)',
      passMarker: 'ALL_TESTS_PASSED',
      failMarker: 'TEST_FAILED:',
      example: `On success: std::cout << "ALL_TESTS_PASSED" << std::endl; return 0;
On first failure: std::cout << "TEST_FAILED: <reason>" << std::endl; return 1;
Include all needed headers (#include <iostream>, <vector>, <string>, etc). Must compile with g++ -std=c++17.`,
    },
    c: {
      label: 'C (gcc)',
      passMarker: 'ALL_TESTS_PASSED',
      failMarker: 'TEST_FAILED:',
      example: `On success: printf("ALL_TESTS_PASSED\\n"); return 0;
On first failure: printf("TEST_FAILED: <reason>\\n"); return 1;
Include all needed headers (#include <stdio.h>, <stdlib.h>, <string.h>, etc). Must compile with gcc.`,
    },
  };

  const spec = langInstructions[language];

  const prompt = `
You are a senior ${spec.label} engineer. You are given a solution's source code, a list of
example test cases (input/expected output), and constraints.

Write ONE complete, self-contained, compilable/runnable ${spec.label} program that:
1. Includes the given solution code (as-is, adapted minimally so its main function/logic is callable).
2. Runs each test case, comparing actual output to expected output, in order.
3. ${spec.example}
4. Do not run remaining tests after the first failure.

Return ONLY the raw ${spec.label} source code. No markdown, no backticks, no explanation, no extra text.

SOLUTION CODE:
${code}

TEST CASES:
${JSON.stringify(testCases, null, 2)}

CONSTRAINTS:
${constraints || 'None specified'}
`;

  const completion = await groq.chat.completions.create({
    model: 'qwen/qwen3.6-27b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2560,
  });

  let script = completion.choices[0].message.content.trim();
  script = script.replace(/```[\w+]*\n?/g, '').replace(/```/g, '').trim();
  return script;
}

// ─── STEP 3 — Run via Judge0 (external sandbox), never on this host ───
function parseJudge0Result(result) {
  const output = (result.stdout || '') + (result.stderr || '');

  if (output.includes('ALL_TESTS_PASSED')) {
    return { passed: true, reason: null };
  }

  const failMatch = output.match(/TEST_FAILED:\s*(.+)/);
  if (failMatch) {
    return { passed: false, reason: failMatch[1].trim().slice(0, 500) };
  }

  if (!result.success) {
    return { passed: false, reason: (output.trim() || 'Execution failed').slice(0, 500) };
  }

  return { passed: false, reason: output.trim().slice(0, 500) || 'Unknown failure' };
}

async function runScript(language, script, timeoutMs = 6000) {
  if (!['javascript', 'python', 'cpp', 'c'].includes(language)) {
    return { passed: false, reason: `Unsupported language: ${language}` };
  }

  let result;
  try {
    result = await sandboxService.runCode(script, language);
  } catch (err) {
    // Judge0 unreachable/misconfigured -- fail closed, never fall back
    // to executing the script on this host.
    logger.error(`Sandbox execution error: ${err.message}`);
    return { passed: false, reason: `Sandbox unavailable: ${err.message}`.slice(0, 500) };
  }

  return parseJudge0Result(result);
}

// ─── STEP 4 — Test fail hone par Groq se code fix karwao (language-aware) ───
async function fixCodeForTest(language, code, failReason, constraints) {
  const langLabel = { javascript: 'JavaScript', python: 'Python 3', cpp: 'C++', c: 'C' }[language];

  const prompt = `
You are debugging ${langLabel} code that failed a test case.

Original code:
${code}

Test failure reason:
${failReason}

Constraints:
${constraints || 'None specified'}

Fix the code so it passes. Return ONLY the corrected raw ${langLabel} code.
No explanation. No markdown. No backticks.
`;

  const completion = await groq.chat.completions.create({
    model: 'qwen/qwen3.6-27b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  });

  let fixed = completion.choices[0].message.content.trim();
  fixed = fixed.replace(/```[\w+]*\n?/g, '').replace(/```/g, '').trim();
  return fixed;
}

// ─── MAIN — poora verify + self-heal loop, koi bhi supported language ───
async function verifyAndFix(visionResponse, maxAttempts = 4) {
  const extracted = await extractCodeAndTests(visionResponse);
  const language = normalizeLanguage(extracted.language);

  if (!extracted.code || !language) {
    return { applicable: false };
  }

  if (!extracted.testCases || extracted.testCases.length === 0) {
    return { applicable: false };
  }

  let code = extracted.code;
  let attempt = 0;
  let lastReason = '';

  while (attempt < maxAttempts) {
    attempt++;

    let script;
    try {
      script = await buildTestScript(language, code, extracted.testCases, extracted.constraints);
    } catch (e) {
      logger.error(`[VERIFY] Script build failed: ${e.message}`);
      return { applicable: true, success: false, code, attempts: attempt, lastReason: 'Failed to build test harness.' };
    }

    const result = await runScript(language, script);

    if (result.passed) {
      return {
        applicable: true,
        success: true,
        language,
        code,
        attempts: attempt,
        testCasesRun: extracted.testCases.length,
      };
    }

    lastReason = result.reason;
    logger.info(`[VERIFY] [${language}] Attempt ${attempt} failed: ${lastReason}`);

    if (attempt < maxAttempts) {
      code = await fixCodeForTest(language, code, lastReason, extracted.constraints);
    }
  }

  return {
    applicable: true,
    success: false,
    language,
    code,
    attempts: attempt,
    lastReason,
    testCasesRun: extracted.testCases.length,
  };
}

module.exports = { verifyAndFix, normalizeLanguage };