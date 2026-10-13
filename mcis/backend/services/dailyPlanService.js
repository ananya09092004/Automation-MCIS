const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Generate daily execution plan
async function generateDailyPlan(userId, userProfile, activeGoals, userBehavior) {
  try {
    const goalsContext = activeGoals.map(g => g.goal_title).join(', ');
    const bestHours = userBehavior?.best_hours?.join(', ') || '9 AM - 12 PM';
    const personality = userProfile?.personality_type || 'ENTJ';

    const prompt = `Generate an optimized daily execution plan:

User: ${personality} type
Active goals: ${goalsContext}
Best productivity hours: ${bestHours}
Today's date: ${new Date().toISOString().split('T')[0]}

Create a realistic daily plan with:
1. Priority tasks (3-5 critical tasks)
2. Time blocks
3. Break schedule
4. Focus area
5. Stretch goals

Return JSON:
{
  "tasks": [
    { "task": "Study DSA 2 hours", "start_time": "10:00", "duration": 120, "priority": "critical", "goal": "..." },
    { "task": "Practice problems 1 hour", "start_time": "12:00", "duration": 60, "priority": "high", "goal": "..." }
  ],
  "focus_area": "Binary Search & Arrays",
  "estimated_hours": 4.5,
  "priority_level": "high",
  "break_schedule": [
    { "time": "11:00", "duration": 15 }
  ],
  "stretch_goals": ["Complete 10 problems", "Write summary"],
  "success_criteria": "Finish 5 hard problems + review"
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const plan = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, plan };
  } catch (err) {
    logger.error(`Generate plan error: ${err.message}`);
    return { success: false };
  }
}

// Save daily plan
async function saveDailyPlan(userId, plan) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('daily_execution_plan')
      .insert([{
        user_id: userId,
        plan_date: today,
        tasks: plan.tasks || [],
        focus_area: plan.focus_area,
        estimated_hours: plan.estimated_hours,
        priority_level: plan.priority_level,
        total_count: plan.tasks?.length || 0,
        completed_count: 0,
        completion_rate: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    logger.info(`Daily plan saved for ${userId}`);
    return { success: true, plan: data[0] };
  } catch (err) {
    logger.error(`Save plan error: ${err.message}`);
    return { success: false };
  }
}

// Get today's plan
async function getTodayPlan(userId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('daily_execution_plan')
      .select('*')
      .eq('user_id', userId)
      .eq('plan_date', today)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return { success: true, plan: data };
  } catch (err) {
    logger.error(`Get plan error: ${err.message}`);
    return { success: false };
  }
}

// Update task completion
async function updateTaskCompletion(planId, completedCount) {
  try {
    const { data: plan } = await supabase
      .from('daily_execution_plan')
      .select('total_count')
      .eq('id', planId)
      .single();

    const completionRate = plan ? (completedCount / plan.total_count) * 100 : 0;

    const { error } = await supabase
      .from('daily_execution_plan')
      .update({
        completed_count: completedCount,
        completion_rate: completionRate,
        updated_at: new Date().toISOString()
      })
      .eq('id', planId);

    if (error) throw error;
    logger.info(`Tasks updated: ${completedCount}/${plan?.total_count}`);
    return { success: true };
  } catch (err) {
    logger.error(`Update tasks error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  generateDailyPlan,
  saveDailyPlan,
  getTodayPlan,
  updateTaskCompletion
};