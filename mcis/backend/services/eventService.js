const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const { processEventTriggers } = require('./eventTriggerService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Event types
const EVENT_TYPES = {
  USER_ACTION: 'user_action',
  GOAL_PROGRESS: 'goal_progress',
  LEARNING_GAP: 'learning_gap',
  SKILL_MASTERED: 'skill_mastered',
  DEADLINE_APPROACHING: 'deadline_approaching',
  SYSTEM_ALERT: 'system_alert',
  STREAK_MILESTONE: 'streak_milestone',
  PREFERENCE_DETECTED: 'preference_detected'
};

// Create event
async function createEvent(userId, eventType, data) {
  try {
    const { error } = await supabase
      .from('events')
      .insert([{
        user_id: userId,
        event_type: eventType,
        data,
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;
    logger.info(`Event created: ${eventType} for ${userId}`);
    return { success: true, event_type: eventType };
  } catch (err) {
    logger.error(`Create event error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Detect events from user message
function detectEvents(userMessage, messageCount) {
  const events = [];
  const lower = userMessage.toLowerCase();

  // 1. Learning progress detection
  if (lower.includes('completed') || lower.includes('solved') || 
      lower.includes('finished') || lower.includes('done')) {
    events.push({
      type: EVENT_TYPES.GOAL_PROGRESS,
      data: {
        action: 'task_completed',
        description: userMessage.slice(0, 100),
        timestamp: new Date().toISOString()
      }
    });
  }

  // 2. Learning gap detection
  if (lower.includes('confused') || lower.includes('struggling') ||
      lower.includes('dont understand') || lower.includes('help me') ||
      lower.includes('stuck') || lower.includes('nahi samjh')) {
    events.push({
      type: EVENT_TYPES.LEARNING_GAP,
      data: {
        topic: userMessage.slice(0, 100),
        difficulty: 'high',
        needs_help: true
      }
    });
  }

  // 3. Skill mastery detection
  if (lower.includes('master') || lower.includes('expert') ||
      lower.includes('ace') || lower.includes('nailed') ||
      lower.includes('easy') || lower.includes('simple')) {
    events.push({
      type: EVENT_TYPES.SKILL_MASTERED,
      data: {
        skill: userMessage.slice(0, 100),
        confidence: 'high'
      }
    });
  }

  // 4. Deadline approaching detection
  if (lower.includes('deadline') || lower.includes('due') ||
      lower.includes('submission') || lower.includes('exam')) {
    events.push({
      type: EVENT_TYPES.DEADLINE_APPROACHING,
      data: {
        deadline_info: userMessage.slice(0, 100)
      }
    });
  }

  // 5. Preference detection
  if (lower.includes('prefer') || lower.includes('like') ||
      lower.includes('dislike') || lower.includes('hate')) {
    events.push({
      type: EVENT_TYPES.PREFERENCE_DETECTED,
      data: {
        preference: userMessage.slice(0, 100)
      }
    });
  }

  // 6. Streak milestone
  if (messageCount > 0 && messageCount % 10 === 0) {
    events.push({
      type: EVENT_TYPES.STREAK_MILESTONE,
      data: {
        milestone: messageCount,
        congratulations: `${messageCount} messages with MCIS!`
      }
    });
  }

  return events;
}

// Get events for user
async function getUserEvents(userId, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error(`Get events error: ${err.message}`);
    return [];
  }
}

// Process events and generate smart triggers
async function processEvents(userId, events) {
  const triggers = [];

  for (const event of events) {
    switch (event.event_type) {
      case EVENT_TYPES.GOAL_PROGRESS:
        triggers.push({
          type: 'suggestion',
          message: `Great! Task completed. What's next?`,
          priority: 'high'
        });
        break;

      case EVENT_TYPES.LEARNING_GAP:
        triggers.push({
          type: 'help_offer',
          message: `I see you're struggling. Let me break this down step by step.`,
          priority: 'critical'
        });
        break;

      case EVENT_TYPES.SKILL_MASTERED:
        triggers.push({
          type: 'celebration',
          message: `🎉 You're mastering this! Ready for harder challenges?`,
          priority: 'medium'
        });
        break;

      case EVENT_TYPES.DEADLINE_APPROACHING:
        triggers.push({
          type: 'alert',
          message: `⚠️ Deadline detected. Let's create a focused plan.`,
          priority: 'critical'
        });
        break;

      case EVENT_TYPES.STREAK_MILESTONE:
        triggers.push({
          type: 'milestone',
          message: `🏆 ${event.data.congratulations}. Keep the momentum!`,
          priority: 'high'
        });
        break;

      case EVENT_TYPES.PREFERENCE_DETECTED:
        triggers.push({
          type: 'preference',
          message: `Noted your preference. I'll apply this going forward.`,
          priority: 'medium'
        });
        break;
    }
  }

  return triggers;
}

module.exports = {
  EVENT_TYPES,
  createEvent,
  detectEvents,
  getUserEvents,
  processEvents,
  processEventTriggers  // ADD THIS LINE
};