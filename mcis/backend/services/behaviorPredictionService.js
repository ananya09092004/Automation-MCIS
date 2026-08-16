const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Predict user's next action/behavior
async function predictUserBehavior(userId, twin, context) {
  try {
    const prompt = `Based on this digital twin, predict the user's next behavior:

Twin profile:
- Working style: ${twin.working_style}
- Procrastination triggers: ${twin.procrastination_triggers?.join(', ') || 'none'}
- Motivation peaks: ${twin.motivation_peaks?.join(', ') || 'unknown'}
- Stress level: ${twin.neuroticism || 'medium'}

Current context: ${context}
Today: ${new Date().toISOString().split('T')[0]}

Predict:
1. Will they procrastinate today? (probability 0-1)
2. When will stress peak? (time of day)
3. What's their motivation level? (0-1)
4. Recommended intervention?
5. Confidence in prediction?

Return JSON:
{
  "procrastination_probability": 0.6,
  "stress_peak_time": "3 PM",
  "motivation_level": 0.7,
  "recommended_intervention": "...",
  "prediction_confidence": 0.75,
  "reasoning": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const prediction = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Save prediction
    await supabase.from('twin_predictions').insert([{
      user_id: userId,
      prediction_date: new Date().toISOString().split('T')[0],
      prediction_type: 'behavior',
      prediction_text: JSON.stringify(prediction),
      confidence: prediction.prediction_confidence,
      recommended_action: prediction.recommended_intervention
    }]);

    return { success: true, prediction };
  } catch (err) {
    logger.error(`Predict behavior error: ${err.message}`);
    return { success: false };
  }
}

// Predict stress/burnout risk
async function predictStressRisk(userId, twin, recentActivity) {
  try {
    const prompt = `Analyze burnout risk:

Twin stress response: ${twin.stress_responses?.join(', ') || 'unknown'}
Recent activity: ${recentActivity}
Overcommitment tendency: ${(twin.overcommitment_tendency * 100).toFixed(0)}%

Predict:
1. Burnout risk (0-1)?
2. When might it peak?
3. Warning signs?
4. Prevention strategies?

Return JSON:
{
  "burnout_risk": 0.6,
  "peak_date": "2026-06-25",
  "warning_signs": ["..."],
  "prevention_strategies": ["..."],
  "immediate_action": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const risk = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, risk };
  } catch (err) {
    logger.error(`Predict stress error: ${err.message}`);
    return { success: false };
  }
}

// Predict task completion probability
async function predictTaskCompletion(userId, twin, task) {
  try {
    const prompt = `Predict if user will complete this task:

Task: ${task.title}
Duration: ${task.duration} minutes
Priority: ${task.priority}
Due: ${task.due_date}

Twin factors:
- Working style: ${twin.working_style}
- Task preference: ${twin.ideal_task_duration} min tasks
- Success rate: ${(twin.goal_completion_rate * 100).toFixed(0)}%
- Procrastination triggers: ${twin.procrastination_triggers?.join(', ')}

Predict:
1. Completion probability (0-1)?
2. Best time to do it?
3. Potential blockers?
4. How to increase probability?

Return JSON:
{
  "completion_probability": 0.8,
  "best_time": "10:00 AM",
  "blockers": ["..."],
  "optimization": "...",
  "confidence": 0.85
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const taskPrediction = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, prediction: taskPrediction };
  } catch (err) {
    logger.error(`Predict task error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  predictUserBehavior,
  predictStressRisk,
  predictTaskCompletion
};