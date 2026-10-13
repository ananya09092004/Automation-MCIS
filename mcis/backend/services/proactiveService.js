const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Daily goal analysis
async function analyzeGoalsForUser(userId) {
  try {
    // Get user's goals
    const { data: goals } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', userId);

    if (!goals?.length) return [];

    const analysis = [];

    for (const goal of goals) {
      // Get progress
      const { data: updates } = await supabase
        .from('goal_updates')
        .select('*')
        .eq('goal_id', goal.id)
        .order('created_at', { ascending: false })
        .limit(7); // Last 7 days

      const progressPercent = goal.progress || 0;
      
      // Analyze using AI
      const completion = await groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages: [{
          role: 'user',
          content: `User goal: ${goal.title}
Target: ${goal.target}
Current progress: ${progressPercent}%
Last 7 days updates: ${updates?.map(u => u.description).join(', ')}

Provide:
1. Performance assessment (1 sentence)
2. Specific suggestion (1 sentence)
3. Next actionable step

Format: ASSESSMENT|SUGGESTION|STEP`
        }],
        max_tokens: 150,
        temperature: 0.7
      });

      const response = completion.choices[0].message.content;
      const [assessment, suggestion, nextStep] = response.split('|');

      analysis.push({
        goal_id: goal.id,
        goal_title: goal.title,
        progress_percent: progressPercent,
        assessment: assessment?.trim(),
        suggestion: suggestion?.trim(),
        next_step: nextStep?.trim(),
        score: progressPercent / 100
      });
    }

    return analysis;
  } catch (err) {
    logger.error(`Goal analysis error: ${err.message}`);
    return [];
  }
}

// Generate daily briefing
async function generateDailyBriefing(userId) {
  try {
    const analysis = await analyzeGoalsForUser(userId);

    if (!analysis.length) return null;

    const briefing = {
      user_id: userId,
      date: new Date().toISOString().split('T')[0],
      goals_analyzed: analysis.length,
      on_track: analysis.filter(a => a.score >= 0.7).length,
      needs_attention: analysis.filter(a => a.score < 0.5).length,
      suggestions: analysis.map(a => ({
        goal: a.goal_title,
        suggestion: a.suggestion,
        next_step: a.next_step
      })),
      created_at: new Date().toISOString()
    };

    // Save briefing
    await supabase
      .from('daily_briefings')
      .insert([briefing]);

    logger.info(`Daily briefing generated for ${userId}`);
    return briefing;
  } catch (err) {
    logger.error(`Briefing generation error: ${err.message}`);
    return null;
  }
}

// Send notification
async function sendProactiveNotification(userId, message, type = 'suggestion') {
  try {
    await supabase
      .from('notifications')
      .insert([{
        user_id: userId,
        message,
        type,
        read: false,
        created_at: new Date().toISOString()
      }]);

    logger.info(`Notification sent to ${userId}: ${message.slice(0, 50)}`);
  } catch (err) {
    logger.error(`Notification error: ${err.message}`);
  }
}

module.exports = {
  analyzeGoalsForUser,
  generateDailyBriefing,
  sendProactiveNotification
};