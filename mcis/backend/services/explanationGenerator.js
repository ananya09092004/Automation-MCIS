// backend/services/explanationGenerator.js

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
    // Use Claude to explain the WHY
    const explanation = await claude.messages.create({
      model: "claude-opus-4-6",
      messages: [{
        role: "user",
        content: `
          Code: ${code}
          Pattern: ${pattern}
          
          Explain in 2-3 sentences:
          1. Why is this approach used?
          2. What problem does it solve?
          3. When should you use this?
        `
      }]
    });
    
    return explanation.content[0].text;
  }

  async explainAlternatives(code, pattern) {
    // Why NOT use other approaches?
    const explanation = await claude.messages.create({
      model: "claude-opus-4-6",
      messages: [{
        role: "user",
        content: `
          Current approach: ${pattern}
          
          List 2-3 alternative approaches that COULD work but aren't used here.
          For each, explain WHY we chose ${pattern} instead.
          
          Format:
          Alternative 1: [approach]
          Why not: [reason]
        `
      }]
    });
    
    return explanation.content[0].text;
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