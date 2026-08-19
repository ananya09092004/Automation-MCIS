// backend/services/variantGenerator.js
//
// NOTE: previously called `claude.messages.create(...)` with no client
// ever defined (no Anthropic SDK dependency in this project) — every call
// would throw. Rewired to the Groq client already used elsewhere in this
// codebase so it actually runs.

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function askGroq(prompt, maxTokens = 300) {
  const completion = await groq.chat.completions.create({
    model: 'qwen/qwen3.6-27b',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
  });
  return (completion.choices[0].message.content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

class VariantGenerator {
  async createVariant(step) {
    const { pattern, difficulty, context } = step;

    return {
      // Similar problem, slightly different
      problem: await this.generateVariantProblem(pattern, difficulty),
      
      // User solves it independently
      constraints: `You learned ${pattern}. Now apply it here without hints.`,
      
      // Auto-validation
      testCases: await this.generateTestCases(pattern),
      
      // Hints if stuck
      hints: [
        `Remember: Use the ${pattern} pattern`,
        `Start by thinking about...`,
        `Compare with what you just learned`
      ],
      
      // Difficulty increase
      difficulty: difficulty + 1,
      estimatedTime: 15
    };
  }

  async generateVariantProblem(pattern, difficulty) {
    return askGroq(`
      Pattern learned: ${pattern}
      Difficulty: ${difficulty}/10

      Generate a NEW problem that requires using this pattern.
      Make it 20% harder than the original.

      Format:
      Problem: [description]
      Input: [example input]
      Expected Output: [example output]
    `);
  }

  async generateTestCases(pattern) {
    return [
      { input: "basic case", expected: "correct output" },
      { input: "edge case", expected: "correct output" },
      { input: "stress test", expected: "correct output" }
    ];
  }
}

module.exports = new VariantGenerator();