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

// P-SEC-8 (security hardening, pre-launch, D5): this file used to also
// export a `runTests(code, tests)` that never actually ran anything --
// every result came back as `status: 'UNKNOWN'` with a comment admitting
// "Would execute code here". It was imported by routes/coding.js and
// services/codeQualityPipelineService.js but never called by either (dead
// code reachable by no route), so no customer-facing response was ever
// built from its fake result. It has been removed rather than fixed: the
// real, tested, sandboxed implementation already exists and is what's
// actually wired up end to end --
// services/codeQualityPipelineService.js's `runTestsActually`, which runs
// submitted/generated code through the Judge0 sandbox (see
// backend-routing/__tests__/security_hardening.test.js's "RCE fix:
// codeQualityPipelineService.runTestsActually calls the Judge0 sandbox,
// never a local shell"). Keeping a same-shaped, never-invoked fake
// alongside the real one was a launch-readiness/trust risk on its own --
// confusing to anyone reading this code, and one wrong wiring change away
// from silently serving fabricated "UNKNOWN" results to a customer.

module.exports = {
  generateAdversarialTests,
};