const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { safeJsonParse } = require('./jsonExtractor');

// Generate smart recommendations based on event
async function generateRecommendation(event, userContext) {
  try {
    const prompt = `Based on this event: ${JSON.stringify(event)}
    User context: ${userContext || 'New user'}
    
    Generate a JSON recommendation with:
    {
      "suggestion": "specific actionable suggestion",
      "resources": ["resource1", "resource2"],
      "difficulty": "beginner/intermediate/advanced",
      "timeEstimate": "time needed",
      "nextSteps": ["step1", "step2"]
    }
    
    Return ONLY valid JSON, no explanation.`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const recommendation = safeJsonParse(text);
    
    return recommendation;
  } catch (err) {
    logger.error(`Recommendation generation error: ${err.message}`);
    return null;
  }
}

// Save recommendation
async function saveRecommendation(userId, eventType, recommendation) {
  try {
    const { error } = await supabase
      .from('recommendations')
      .insert([{
        user_id: userId,
        event_type: eventType,
        recommendation,
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;
    logger.info(`Recommendation saved for ${eventType}`);
    return { success: true };
  } catch (err) {
    logger.error(`Save recommendation error: ${err.message}`);
    return { success: false };
  }
}

// Get recommendations for user
async function getUserRecommendations(userId, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('recommendations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error(`Get recommendations error: ${err.message}`);
    return [];
  }
}

module.exports = {
  generateRecommendation,
  saveRecommendation,
  getUserRecommendations
};