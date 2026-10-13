const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Detect algorithm type from problem
async function detectAlgorithm(userId, problemStatement) {
  try {
    const prompt = `Analyze this coding problem and detect the algorithm/pattern:

Problem: "${problemStatement}"

Detect:
1. Primary algorithm (e.g., BFS, Binary Search, DP, etc)
2. Confidence (0-1)
3. Why this algorithm?
4. Alternative algorithms that could work
5. Edge cases specific to this algorithm

Return JSON:
{
  "primary_algorithm": "...",
  "confidence": 0.85,
  "why": "...",
  "alternatives": ["...", "..."],
  "edge_cases": ["...", "..."],
  "difficulty": "medium"
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const detection = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Save detection
    await supabase.from('algorithm_detection').insert([{
      user_id: userId,
      problem: problemStatement,
      detected_algorithm: detection.primary_algorithm,
      confidence: detection.confidence,
      reasoning: detection.why
    }]);

    return { success: true, detection };
  } catch (err) {
    logger.error(`Detect algorithm error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  detectAlgorithm
};