const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize digital twin from user data
async function initializeDigitalTwin(userId, userData) {
  try {
    const prompt = `Based on this user data, build a digital twin personality model:

Messages: ${userData.messageCount || 0}
Goals completed: ${userData.completedGoals || 0}
Learning style: ${userData.learningStyle || 'unknown'}
Personality type: ${userData.personalityType || 'unknown'}
Risk tolerance: ${userData.riskTolerance || 'medium'}
Communication style: ${userData.communicationStyle || 'formal'}

Create a comprehensive digital twin model:
{
  "personality_traits": {
    "openness": 0.7,
    "conscientiousness": 0.8,
    "extraversion": 0.6,
    "agreeableness": 0.75,
    "neuroticism": 0.4
  },
  "working_style": "...",
  "decision_pattern": "...",
  "learning_pattern": "...",
  "procrastination_triggers": ["..."],
  "motivation_peaks": ["..."],
  "stress_responses": ["..."],
  "success_factors": ["..."],
  "failure_patterns": ["..."],
  "prefers_detail": true,
  "prefers_examples": true,
  "prefers_deadline": true,
  "communication_style": "...",
  "feedback_preference": "...",
  "optimism_level": 0.7,
  "risk_aversion": 0.4,
  "overcommitment_tendency": 0.6
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const twinModel = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Save to database
    const { data, error } = await supabase
      .from('digital_twin_model')
      .upsert([{
        user_id: userId,
        personality_traits: twinModel.personality_traits,
        working_style: twinModel.working_style,
        decision_pattern: twinModel.decision_pattern,
        learning_pattern: twinModel.learning_pattern,
        procrastination_triggers: twinModel.procrastination_triggers,
        motivation_peaks: twinModel.motivation_peaks,
        stress_responses: twinModel.stress_responses,
        success_factors: twinModel.success_factors,
        failure_patterns: twinModel.failure_patterns,
        prefers_detail: twinModel.prefers_detail,
        prefers_examples: twinModel.prefers_examples,
        prefers_deadline: twinModel.prefers_deadline,
        communication_style: twinModel.communication_style,
        feedback_preference: twinModel.feedback_preference,
        optimism_level: twinModel.optimism_level,
        risk_aversion: twinModel.risk_aversion,
        confidence_score: 0.6,
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    logger.info(`Digital twin initialized for ${userId}`);
    return { success: true, twin: data[0] };
  } catch (err) {
    logger.error(`Initialize twin error: ${err.message}`);
    return { success: false };
  }
}

// Get user's digital twin
async function getUserDigitalTwin(userId) {
  try {
    const { data, error } = await supabase
      .from('digital_twin_model')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  } catch (err) {
    logger.error(`Get twin error: ${err.message}`);
    return null;
  }
}

// Update twin confidence based on accuracy
async function updateTwinConfidence(userId, accuracy) {
  try {
    const twin = await getUserDigitalTwin(userId);
    
    if (!twin) return { success: false };

    // Increase confidence if accurate, decrease if not
    const newConfidence = Math.min(1, Math.max(0, 
      twin.confidence_score + (accuracy > 0.7 ? 0.05 : -0.02)
    ));

    const { error } = await supabase
      .from('digital_twin_model')
      .update({ 
        confidence_score: newConfidence,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) throw error;

    return { success: true, new_confidence: newConfidence };
  } catch (err) {
    logger.error(`Update confidence error: ${err.message}`);
    return { success: false };
  }
}

// Get twin summary for chat context
async function getTwinSummary(userId) {
  try {
    const twin = await getUserDigitalTwin(userId);
    
    if (!twin) return '';

    const summary = `DIGITAL TWIN INSIGHTS:
Working style: ${twin.working_style}
Decision pattern: ${twin.decision_pattern}
Procrastination triggers: ${twin.procrastination_triggers?.slice(0, 2).join(', ') || 'none detected'}
Motivation peaks: ${twin.motivation_peaks?.slice(0, 2).join(', ') || 'unknown'}
Stress response: ${twin.stress_responses?.[0] || 'unknown'}
Key success factors: ${twin.success_factors?.slice(0, 2).join(', ') || 'unknown'}
Optimism level: ${(twin.optimism_level * 100).toFixed(0)}%
Twin confidence: ${(twin.confidence_score * 100).toFixed(0)}%`;

    return summary;
  } catch (err) {
    logger.error(`Get summary error: ${err.message}`);
    return '';
  }
}

module.exports = {
  initializeDigitalTwin,
  getUserDigitalTwin,
  updateTwinConfidence,
  getTwinSummary
};