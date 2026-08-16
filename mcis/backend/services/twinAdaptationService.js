const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Generate adaptation recommendation from twin
async function generateAdaptation(userId, twin, performance) {
  try {
    const prompt = `Based on user performance and twin model, recommend a system adaptation:

Twin insights:
- Working style: ${twin.working_style}
- Ideal task duration: ${twin.ideal_task_duration} minutes
- Focus duration: ${twin.focus_duration} minutes
- Stress response: ${twin.stress_responses?.join(', ')}

Performance:
- Task completion rate: ${performance.completion_rate}%
- Stress level: ${performance.stress_level}/10
- Motivation: ${performance.motivation}/10
- Happiness: ${performance.happiness}/10

Recommend:
1. What system aspect to adapt? (daily_plan, task_duration, reminders, difficulty, break_schedule)
2. Specific change?
3. Why?
4. Expected improvement?

Return JSON:
{
  "adaptation_target": "...",
  "change": "...",
  "reasoning": "...",
  "expected_improvement": 0.15,
  "priority": "high"
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const adaptation = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, adaptation };
  } catch (err) {
    logger.error(`Generate adaptation error: ${err.message}`);
    return { success: false };
  }
}

// Apply adaptation
async function applyAdaptation(userId, adaptation, systemComponent) {
  try {
    // Save adaptation record
    const { data, error } = await supabase
      .from('twin_adaptations')
      .insert([{
        user_id: userId,
        adaptation_date: new Date().toISOString().split('T')[0],
        system_component: systemComponent,
        change_made: adaptation.change,
        reasoning: adaptation.reasoning
      }])
      .select();

    if (error) throw error;

    logger.info(`Adaptation applied: ${systemComponent}`);
    return { success: true, adaptation_id: data[0].id };
  } catch (err) {
    logger.error(`Apply adaptation error: ${err.message}`);
    return { success: false };
  }
}

// Get adaptation history
async function getAdaptationHistory(userId, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('twin_adaptations')
      .select('*')
      .eq('user_id', userId)
      .order('adaptation_date', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return { success: true, adaptations: data || [] };
  } catch (err) {
    logger.error(`Get adaptation history error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  generateAdaptation,
  applyAdaptation,
  getAdaptationHistory
};