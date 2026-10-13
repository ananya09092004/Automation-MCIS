const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Generate decision recommendation
async function generateRecommendation(futures, userProfile, userGoals) {
  try {
    const futuresContext = futures.map(f => 
      `${f.path_name}: Success ${(f.success_probability*100).toFixed(0)}%, ` +
      `Alignment ${(f.alignment_with_values*100).toFixed(0)}%, ` +
      `Final: ${f.final_state}`
    ).join('\n');

    const prompt = `Based on these simulated futures:

${futuresContext}

User profile:
- Type: ${userProfile.personality_type}
- Risk tolerance: ${userProfile.risk_tolerance}
- Motivations: ${userProfile.motivation_drivers?.join(', ')}

User goals: ${userGoals.join(', ')}

Recommend the BEST path. Explain why.
Also mention: opportunities, warnings, timeline.

Return JSON:
{
  "recommended_path": "Path A: ...",
  "reasoning": "...",
  "confidence": 0.85,
  "opportunities": ["...", "..."],
  "warning_flags": ["...", "..."],
  "timeline_insight": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const recommendation = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, recommendation };
  } catch (err) {
    logger.error(`Generate recommendation error: ${err.message}`);
    return { success: false };
  }
}

// Save recommendation
async function saveRecommendation(userId, simulationId, recommendation) {
  try {
    const { error } = await supabase
      .from('decision_recommendations')
      .insert([{
        user_id: userId,
        simulation_id: simulationId,
        recommended_path: recommendation.recommended_path,
        reasoning: recommendation.reasoning,
        confidence_level: recommendation.confidence,
        warning_flags: recommendation.warning_flags,
        opportunities: recommendation.opportunities,
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;
    logger.info(`Recommendation saved for ${userId}`);
    return { success: true };
  } catch (err) {
    logger.error(`Save recommendation error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  generateRecommendation,
  saveRecommendation
};