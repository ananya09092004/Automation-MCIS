const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Store event replay log
async function logEventReplay(userId, eventId, replayData) {
  try {
    const { error } = await supabase
      .from('event_replays')
      .insert([{
        user_id: userId,
        event_id: eventId,
        replay_data: replayData,
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;
    logger.info(`Event replay logged: ${eventId}`);
  } catch (err) {
    logger.error(`Log replay error: ${err.message}`);
  }
}

// Replay event with original data
async function replayEvent(eventId) {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (error) throw error;
    
    logger.info(`Event replayed: ${eventId}`);
    return { success: true, event: data };
  } catch (err) {
    logger.error(`Replay event error: ${err.message}`);
    return { success: false };
  }
}

// Get event audit trail
async function getEventAuditTrail(userId, eventId) {
  try {
    const { data, error } = await supabase
      .from('event_replays')
      .select('*')
      .eq('user_id', userId)
      .eq('event_id', eventId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error(`Get audit trail error: ${err.message}`);
    return [];
  }
}

module.exports = {
  logEventReplay,
  replayEvent,
  getEventAuditTrail
};