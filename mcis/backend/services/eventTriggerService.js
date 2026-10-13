const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const { sendProactiveNotification } = require('./proactiveService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Generate smart responses based on events
async function generateEventResponse(event) {
  const responses = {
    goal_progress: {
      message: `🎯 Great progress! You're making momentum. What's next?`,
      type: 'celebration',
      priority: 'high'
    },
    learning_gap: {
      message: `💡 I see you're stuck. Let me break this down step-by-step with examples.`,
      type: 'help',
      priority: 'critical'
    },
    skill_mastered: {
      message: `🏆 You're mastering this! Ready for harder challenges?`,
      type: 'congratulation',
      priority: 'high'
    },
    deadline_approaching: {
      message: `⚠️ Deadline detected! Let's create a focused plan to finish in time.`,
      type: 'alert',
      priority: 'critical'
    },
    streak_milestone: {
      message: `🔥 ${event.data.congratulations} Keep this streak alive!`,
      type: 'milestone',
      priority: 'high'
    },
    preference_detected: {
      message: `✅ Noted your preference. I'll apply this going forward.`,
      type: 'acknowledgment',
      priority: 'medium'
    }
  };

  return responses[event.event_type] || {
    message: 'Something interesting happened!',
    type: 'info',
    priority: 'medium'
  };
}

// Execute trigger - Create notification + store action
async function executeTrigger(userId, event) {
  try {
    // FIX: generateEventResponse is async but was called without `await`,
    // so `response` was a Promise object — response.message/.type/.priority
    // were all undefined, and the insert below silently sent `message:
    // undefined`, which Supabase/Postgres rejected as a NOT NULL violation.
    const response = await generateEventResponse(event);
    
    // Create notification
    const { error } = await supabase
      .from('notifications')
      .insert([{
        user_id: userId,
        message: response.message,
        type: response.type,
        read: false,
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;

    logger.info(`Trigger executed: ${event.event_type} → Notification created`);
    return { success: true, notification: response };
  } catch (err) {
    logger.error(`Execute trigger error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Process multiple events and execute all triggers
async function processEventTriggers(userId, events) {
  const results = [];

  for (const event of events) {
    const result = await executeTrigger(userId, event);
    results.push({
      event_type: event.event_type,
      trigger_result: result
    });
  }

  logger.info(`Processed ${results.length} event triggers`);
  return results;
}

// Get trigger history for user
async function getTriggerHistory(userId, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error(`Get trigger history error: ${err.message}`);
    return [];
  }
}

module.exports = {
  generateEventResponse,
  executeTrigger,
  processEventTriggers,
  getTriggerHistory
};