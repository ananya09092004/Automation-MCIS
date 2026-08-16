const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Record actual outcome of prediction
async function recordPredictionOutcome(userId, predictionId, actualOutcome, userFeedback) {
  try {
    // Get prediction
    const { data: prediction } = await supabase
      .from('twin_predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (!prediction) return { success: false };

    // Calculate accuracy
    let accuracy = 0.5;
    if (actualOutcome === 'true' && prediction.confidence > 0.5) accuracy = 1;
    if (actualOutcome === 'false' && prediction.confidence < 0.5) accuracy = 1;
    if (actualOutcome === 'true' && prediction.confidence < 0.5) accuracy = 0;

    // Update prediction with outcome
    await supabase
      .from('twin_predictions')
      .update({
        actual_outcome: actualOutcome,
        was_accurate: accuracy > 0.7
      })
      .eq('id', predictionId);

    // Record learning
    const learningPrompt = `User gave feedback on a prediction:
Prediction: ${prediction.prediction_text}
Actual outcome: ${actualOutcome}
User feedback: ${userFeedback}

What did the twin learn from this?
{
  "new_insight": "...",
  "pattern_found": "...",
  "accuracy_improved": 0.05
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: learningPrompt }],
      max_tokens: 300,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const learning = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Save learning
    await supabase.from('twin_learning_log').insert([{
      user_id: userId,
      learning_date: new Date().toISOString().split('T')[0],
      new_insight: learning.new_insight,
      pattern_found: learning.pattern_found,
      accuracy_improved: learning.accuracy_improved,
      supporting_data: {
        prediction: prediction.prediction_text,
        outcome: actualOutcome,
        feedback: userFeedback
      }
    }]);

    logger.info(`Twin learned from prediction outcome`);
    return { success: true, accuracy, learning };
  } catch (err) {
    logger.error(`Record outcome error: ${err.message}`);
    return { success: false };
  }
}

// Get twin learning history
async function getTwinLearningHistory(userId, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('twin_learning_log')
      .select('*')
      .eq('user_id', userId)
      .order('learning_date', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return { success: true, learning_history: data || [] };
  } catch (err) {
    logger.error(`Get learning history error: ${err.message}`);
    return { success: false };
  }
}

// Get twin accuracy stats
async function getTwinAccuracyStats(userId) {
  try {
    const { data, error } = await supabase
      .from('twin_predictions')
      .select('confidence, was_accurate')
      .eq('user_id', userId)
      .not('was_accurate', 'is', null);

    if (error || !data || data.length === 0) {
      return { success: true, stats: { accuracy: 0, total_predictions: 0 } };
    }

    const accurate = data.filter(p => p.was_accurate).length;
    const accuracy = (accurate / data.length) * 100;

    return {
      success: true,
      stats: {
        accuracy: accuracy.toFixed(1),
        total_predictions: data.length,
        accurate_predictions: accurate,
        avg_confidence: (data.reduce((sum, p) => sum + p.confidence, 0) / data.length).toFixed(2)
      }
    };
  } catch (err) {
    logger.error(`Get stats error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  recordPredictionOutcome,
  getTwinLearningHistory,
  getTwinAccuracyStats
};