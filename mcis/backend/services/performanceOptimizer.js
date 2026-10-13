const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Create missing indexes
async function optimizeIndexes() {
  try {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_events_user_type ON events(user_id, event_type);',
      'CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);',
      'CREATE INDEX IF NOT EXISTS idx_recommendations_user ON recommendations(user_id);'
    ];

    for (const index of indexes) {
      await supabase.rpc('raw_sql', { sql: index }).catch(() => {
        logger.info(`Index already exists or skipped`);
      });
    }

    logger.info('✅ Index optimization complete');
  } catch (err) {
    logger.error(`Index optimization error: ${err.message}`);
  }
}

// Batch process events
async function batchProcessEvents(events, batchSize = 10) {
  const batches = [];
  for (let i = 0; i < events.length; i += batchSize) {
    batches.push(events.slice(i, i + batchSize));
  }
  return batches;
}

// Cache event results
const eventCache = new Map();

function cacheEventResult(userId, eventType, result, ttl = 3600000) {
  const key = `${userId}:${eventType}`;
  eventCache.set(key, { result, expiry: Date.now() + ttl });
}

function getCachedEventResult(userId, eventType) {
  const key = `${userId}:${eventType}`;
  const cached = eventCache.get(key);
  
  if (cached && cached.expiry > Date.now()) {
    return cached.result;
  }
  
  eventCache.delete(key);
  return null;
}

// Clean old events (older than 30 days)
async function cleanOldEvents(daysOld = 30) {
  try {
    const date = new Date();
    date.setDate(date.getDate() - daysOld);

    const { error } = await supabase
      .from('events')
      .delete()
      .lt('created_at', date.toISOString());

    if (error) throw error;
    logger.info(`✅ Cleaned events older than ${daysOld} days`);
  } catch (err) {
    logger.error(`Clean old events error: ${err.message}`);
  }
}

module.exports = {
  optimizeIndexes,
  batchProcessEvents,
  cacheEventResult,
  getCachedEventResult,
  cleanOldEvents
};