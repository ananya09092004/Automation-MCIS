const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Break down goal into phases
async function breakDownGoal(goal, timelineMonths = 6) {
  try {
    const prompt = `Break down this goal into executable phases:

Goal: "${goal}"
Timeline: ${timelineMonths} months

Create a detailed breakdown with:
1. Phases (3-5 phases, each 1-2 months)
2. Weekly tasks for each phase
3. Daily tasks (samples)
4. Key milestones
5. Success criteria

Return JSON:
{
  "phases": [
    {
      "name": "Phase 1: Foundation",
      "duration_weeks": 4,
      "description": "...",
      "objectives": ["...", "..."],
      "weekly_tasks": [
        { "week": 1, "tasks": ["...", "..."], "focus": "..." }
      ]
    }
  ],
  "total_weeks": 24,
  "milestones": [
    { "week": 4, "name": "Foundation complete", "deliverable": "..." }
  ],
  "daily_tasks_sample": [
    { "task": "Study 1 hour", "time_required": 60, "priority": "high" },
    { "task": "Practice 30 min", "time_required": 30, "priority": "high" }
  ],
  "success_criteria": ["...", "..."]
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const breakdown = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, breakdown };
  } catch (err) {
    logger.error(`Goal breakdown error: ${err.message}`);
    return { success: false };
  }
}

// Create goal with breakdown
async function createGoalWithBreakdown(userId, goalTitle, goalDescription, targetDate) {
  try {
    // Calculate timeline
    const today = new Date();
    const target = new Date(targetDate);
    const timelineMonths = Math.ceil((target - today) / (1000 * 60 * 60 * 24 * 30));

    // Break down goal
    const breakdownResult = await breakDownGoal(goalTitle, timelineMonths);
    if (!breakdownResult.success) throw new Error('Breakdown failed');

    const breakdown = breakdownResult.breakdown;

    // Save to database
    const { data, error } = await supabase
      .from('goal_breakdowns')
      .insert([{
        user_id: userId,
        goal_title: goalTitle,
        goal_description: goalDescription,
        target_date: targetDate,
        phases: breakdown.phases,
        weekly_tasks: breakdown.weekly_tasks || [],
        daily_tasks: breakdown.daily_tasks_sample || [],
        milestones: breakdown.milestones || [],
        current_progress: 0,
        tasks_completed: 0,
        tasks_total: breakdown.milestones?.length || 5,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    logger.info(`Goal created with breakdown: ${goalTitle}`);
    return { success: true, goal: data[0] };
  } catch (err) {
    logger.error(`Create goal error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Get goal with breakdown
async function getGoalBreakdown(userId, goalId) {
  try {
    const { data, error } = await supabase
      .from('goal_breakdowns')
      .select('*')
      .eq('user_id', userId)
      .eq('id', goalId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return { success: true, goal: data };
  } catch (err) {
    logger.error(`Get goal error: ${err.message}`);
    return { success: false };
  }
}

// Update goal progress
async function updateGoalProgress(goalId, progress) {
  try {
    const { error } = await supabase
      .from('goal_breakdowns')
      .update({ 
        current_progress: progress,
        updated_at: new Date().toISOString()
      })
      .eq('id', goalId);

    if (error) throw error;
    logger.info(`Goal progress updated: ${progress}%`);
    return { success: true };
  } catch (err) {
    logger.error(`Update progress error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  breakDownGoal,
  createGoalWithBreakdown,
  getGoalBreakdown,
  updateGoalProgress
};