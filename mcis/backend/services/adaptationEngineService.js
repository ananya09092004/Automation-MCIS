const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Conduct weekly review
async function conductWeeklyReview(userId, goalId) {
  try {
    // Get goal progress
    const { data: goal } = await supabase
      .from('goal_breakdowns')
      .select('*')
      .eq('id', goalId)
      .single();

    if (!goal) return { success: false, error: 'Goal not found' };

    // Get daily plans from past week
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { data: weekPlans } = await supabase
      .from('daily_execution_plan')
      .select('completion_rate')
      .eq('user_id', userId)
      .gte('plan_date', weekAgo.toISOString().split('T')[0]);

    const avgCompletion = weekPlans?.reduce((sum, p) => sum + p.completion_rate, 0) / (weekPlans?.length || 1) || 0;

    const prompt = `Conduct a goal review:

Goal: ${goal.goal_title}
Current progress: ${goal.current_progress * 100}%
Task completion this week: ${avgCompletion.toFixed(0)}%
Status: ${goal.status}

Analyze and provide:
1. What went well?
2. What didn't work?
3. Blockers?
4. Adjustments needed?
5. Next week focus?

Return JSON:
{
  "what_worked": "...",
  "what_didnt": "...",
  "blockers": ["...", "..."],
  "adjustments": {
    "daily_hours": 3,
    "focus_shift": "...",
    "new_strategy": "..."
  },
  "next_week_focus": "...",
  "recommendation": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const review = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Save review
    const { error: saveError } = await supabase
      .from('goal_reviews')
      .insert([{
        user_id: userId,
        goal_id: goalId,
        review_date: new Date().toISOString().split('T')[0],
        review_type: 'weekly',
        progress_percent: goal.current_progress * 100,
        what_worked: review.what_worked,
        what_didnt: review.what_didnt,
        blockers: review.blockers,
        adjustments: review.adjustments,
        new_focus: review.next_week_focus,
        created_at: new Date().toISOString()
      }]);

    if (saveError) throw saveError;

    logger.info(`Weekly review completed for ${goalId}`);
    return { success: true, review };
  } catch (err) {
    logger.error(`Weekly review error: ${err.message}`);
    return { success: false };
  }
}

// Auto-adapt plan based on performance
async function adaptPlan(userId, goalId, performance) {
  try {
    const { data: goal } = await supabase
      .from('goal_breakdowns')
      .select('*')
      .eq('id', goalId)
      .single();

    if (!goal) return { success: false };

    let adaptation = {};

    if (performance < 50) {
      // Too many tasks, reduce
      adaptation = {
        action: 'reduce_tasks',
        message: 'Too many tasks. Reducing by 30%.',
        new_daily_tasks: Math.ceil(goal.daily_tasks?.length * 0.7) || 3
      };
    } else if (performance > 90) {
      // Can do more, increase
      adaptation = {
        action: 'increase_difficulty',
        message: 'Great progress! Increasing challenge.',
        new_daily_tasks: Math.ceil(goal.daily_tasks?.length * 1.3) || 5
      };
    } else {
      adaptation = {
        action: 'maintain',
        message: 'On track. Maintaining current pace.',
        new_daily_tasks: goal.daily_tasks?.length || 4
      };
    }

    // Update goal
    await supabase
      .from('goal_breakdowns')
      .update({
        daily_tasks: adaptation.new_daily_tasks,
        updated_at: new Date().toISOString()
      })
      .eq('id', goalId);

    logger.info(`Plan adapted: ${adaptation.action}`);
    return { success: true, adaptation };
  } catch (err) {
    logger.error(`Adapt plan error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  conductWeeklyReview,
  adaptPlan
};