// backend/services/explanationGenerator.js
//
// NOTE: this previously called `claude.messages.create(...)` with no
// `claude` client ever required/defined anywhere in the project (there's
// no Anthropic SDK dependency in package.json — the rest of the codebase
// uses Groq/Gemini). Any call would throw "claude is not defined". Rewired
// to use the Groq client that's already a project dependency and already
// used elsewhere (see goals.js, plannerService.js) so this actually runs
// without adding a new API key requirement.

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function askGroq(prompt, maxTokens = 300) {
  const completion = await groq.chat.completions.create({
    model: 'qwen/qwen3.6-27b',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.4,
  });
  return (completion.choices[0].message.content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

class ExplanationGenerator {
  async explain(step) {
    const { code, pattern, context } = step;

    return {
      // WHY this approach?
      reasoning: await this.generateReasoning(code, pattern),
      
      // WHAT does it do?
      summary: await this.generateSummary(code),
      
      // WHY not other ways?
      alternatives: await this.explainAlternatives(code, pattern),
      
      // WHEN to use?
      useCases: await this.identifyUseCases(pattern),
      
      // WHAT to watch?
      commonMistakes: await this.findCommonMistakes(pattern),
      
      // Visual explanation
      visualization: await this.generateVisualization(code)
    };
  }

  async generateReasoning(code, pattern) {
    return askGroq(`
      Code/step: ${code}
      Pattern: ${pattern}

      Explain in 2-3 sentences:
      1. Why is this approach used?
      2. What problem does it solve?
      3. When should you use this?
    `);
  }

  async explainAlternatives(code, pattern) {
    return askGroq(`
      Current approach: ${pattern}

      List 2-3 alternative approaches that COULD work but aren't used here.
      For each, explain WHY we chose ${pattern} instead.

      Format:
      Alternative 1: [approach]
      Why not: [reason]
    `);
  }

  async identifyUseCases(pattern) {
    return [
      `When you need to ${pattern}`,
      `In scenarios with high ${pattern} requirements`,
      `When performance matters for ${pattern}`
    ];
  }

  async findCommonMistakes(pattern) {
    return [
      `Forgetting to ${pattern}`,
      `Implementing ${pattern} incorrectly by not considering edge cases`,
      `Using ${pattern} when it's not necessary (over-engineering)`
    ];
  }

  async generateVisualization(code) {
    // Create ASCII diagram or flowchart
    return `
      [Input]
         ↓
      [Process: Your code]
         ↓
      [Output]
    `;
  }
}

module.exports = new ExplanationGenerator();