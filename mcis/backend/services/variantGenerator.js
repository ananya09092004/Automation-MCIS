// backend/services/variantGenerator.js

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
    const prompt = `
      Pattern learned: ${pattern}
      Difficulty: ${difficulty}/10
      
      Generate a NEW problem that requires using this pattern.
      Make it 20% harder than the original.
      
      Format:
      Problem: [description]
      Input: [example input]
      Expected Output: [example output]
    `;

    const response = await claude.messages.create({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: prompt }]
    });

    return response.content[0].text;
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