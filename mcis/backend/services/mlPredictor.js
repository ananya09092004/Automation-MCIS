const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Predict next likely event
async function predictNextEvent(userId, recentEvents) {
  try {
    const eventSummary = recentEvents
      .slice(0, 10)
      .map(e => e.event_type)
      .join(', ');

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{
        role: 'user',
        content: `Based on these recent events: ${eventSummary}
        
Predict the next likely event (just one word):
- goal_progress
- learning_gap
- skill_mastered
- deadline_approaching
- preference_detected
- streak_milestone

Return ONLY the event name.`
      }],
      max_tokens: 50,
      temperature: 0.7
    });

    const predicted = completion.choices[0].message.content.trim().toLowerCase();
    logger.info(`Predicted next event: ${predicted}`);
    return { predicted, confidence: 0.75 };
  } catch (err) {
    logger.error(`Prediction error: ${err.message}`);
    return null;
  }
}

// Detect anomalies in user behavior
async function detectAnomalies(userId, events) {
  try {
    const normalPattern = {
      goal_progress: 0.3,
      learning_gap: 0.2,
      skill_mastered: 0.3,
      deadline_approaching: 0.1,
      preference_detected: 0.1
    };

    const actualPattern = {};
    events.forEach(e => {
      actualPattern[e.event_type] = (actualPattern[e.event_type] || 0) + 1;
    });

    Object.keys(actualPattern).forEach(k => {
      actualPattern[k] = actualPattern[k] / events.length;
    });

    const anomalies = [];
    Object.keys(actualPattern).forEach(eventType => {
      const actual = actualPattern[eventType] || 0;
      const normal = normalPattern[eventType] || 0;
      
      if (Math.abs(actual - normal) > 0.2) {
        anomalies.push({
          event_type: eventType,
          deviation: ((actual - normal) * 100).toFixed(2) + '%'
        });
      }
    });

    return anomalies.length > 0 ? anomalies : null;
  } catch (err) {
    logger.error(`Anomaly detection error: ${err.message}`);
    return null;
  }
}

module.exports = {
  predictNextEvent,
  detectAnomalies
};