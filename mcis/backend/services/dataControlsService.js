const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const USER_DATA_TABLES = [
  'chats',
  'conversations',
  'user_memories',
  'memory_vectors',
  'goals',
  'goal_updates',
  'goal_breakdowns',
  'goal_reviews',
  'daily_execution_plan',
  'notifications',
  'events',
  'life_timeline',
  'generated_projects',
  'user_preferences',
  'user_profiles',
  'user_deep_profile',
  'user_coding_profile',
  'digital_twin_model',
  'knowledge_nodes',
  'knowledge_edges',
  'execution_memory',
  'execution_metrics',
  'user_analytics',
  'recommendations',
  'decision_recommendations',
  'decision_simulations',
  'simulated_futures',
  'twin_predictions',
  'twin_learning_log',
  'twin_adaptations',
  'chat_summaries',
  'pdf_vectors',
  'code_learning',
  'algorithm_detection',
  'behavior_patterns',
  'user_integrations',
];

async function selectTableForUser(table, userId) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('user_id', userId);

  if (error) {
    logger.warn(`Data export skipped ${table}: ${error.message}`);
    return { table, rows: [], skipped: true, reason: error.message };
  }

  return { table, rows: data || [], skipped: false };
}

async function exportUserData(userId) {
  const tables = await Promise.all(USER_DATA_TABLES.map(table => selectTableForUser(table, userId)));

  return {
    success: true,
    exportedAt: new Date().toISOString(),
    userId,
    tables: tables.reduce((acc, item) => {
      acc[item.table] = item.rows;
      return acc;
    }, {}),
    skippedTables: tables
      .filter(item => item.skipped)
      .map(item => ({ table: item.table, reason: item.reason })),
  };
}

async function deleteTableForUser(table, userId) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('user_id', userId);

  if (error) {
    logger.warn(`Data delete skipped ${table}: ${error.message}`);
    return { table, deleted: false, reason: error.message };
  }

  return { table, deleted: true };
}

async function deleteUserData(userId) {
  const results = [];

  for (const table of USER_DATA_TABLES) {
    results.push(await deleteTableForUser(table, userId));
  }

  return {
    success: true,
    deletedAt: new Date().toISOString(),
    userId,
    results,
    note: 'Firebase Authentication account deletion must be handled separately with Firebase Admin credentials.',
  };
}

module.exports = {
  USER_DATA_TABLES,
  exportUserData,
  deleteUserData,
};
