const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Generate algorithm-specific tests
async function generateAdversarialTests(userId, algorithm, problemStatement) {
  try {
    const prompt = `Generate adversarial test cases specific to this algorithm:

Algorithm: ${algorithm}
Problem: "${problemStatement}"

Generate 8-10 edge case tests that would fail if the algorithm is:
1. Implemented incorrectly
2. Missing pattern understanding
3. Not handling edge cases

For ${algorithm}, test:
- Boundary conditions
- Pattern-specific edge cases
- Performance limits
- Special cases

Return JSON:
{
  "tests": [
    { "input": "...", "expected": "...", "why": "tests ..." },
    ...
  ],
  "description": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const testSuite = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, tests: testSuite.tests };
  } catch (err) {
    logger.error(`Generate tests error: ${err.message}`);
    return { success: false };
  }
}

// Run tests and collect results
async function runTests(code, tests) {
  try {
    const results = [];
    
    for (const test of tests) {
      try {
        // Simulate test execution (in real implementation, use sandboxed environment)
        const result = {
          input: test.input,
          expected: test.expected,
          status: 'UNKNOWN', // Would execute code here
          message: test.why
        };
        results.push(result);
      } catch (err) {
        results.push({
          input: test.input,
          expected: test.expected,
          status: 'ERROR',
          message: err.message
        });
      }
    }

    return results;
  } catch (err) {
    logger.error(`Run tests error: ${err.message}`);
    return [];
  }
}

module.exports = {
  generateAdversarialTests,
  runTests
};