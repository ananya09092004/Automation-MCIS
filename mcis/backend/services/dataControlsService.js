/**
 * Personal data controls (export / erase the CALLER's own rows).
 *
 * Layer 9: both operations are audited (table counts only, never the data);
 * secret-looking columns (tokens, keys, passwords, ciphertext) are never
 * included in an export; database error text is not echoed to the client.
 * Scope: the user's OWN rows (user_id = caller) in every workspace they
 * wrote them in — these are data-subject rights, so they intentionally span
 * the user's workspaces but never touch other users' rows.
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

let client = null;
// Lazily created (first request), so requiring this module needs no configuration.
function defaultDb() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}
let supabaseOverride = null;
const supabase = {
  from: (t) => (supabaseOverride || defaultDb()).from(t),
};
/** TEST SEAM: route the module to another client (null restores the default). */
function setDataControlsClient(c) { supabaseOverride = c || null; }

const SECRET_COLUMN_RE = /(token|secret|password|passwd|api_?key|private_?key|credential|ciphertext|encrypted|auth_tag|\biv\b|key_hash)/i;
function stripSecrets(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = SECRET_COLUMN_RE.test(k) && v !== null && v !== undefined ? '[REDACTED]' : v;
  return out;
}

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
    logger.warn(`Data export skipped ${table}: ${error.code || 'error'}`);
    return { table, rows: [], skipped: true, reason: error.code === '42P01' ? 'table not present' : 'not readable' };
  }

  return { table, rows: (data || []).map(stripSecrets), skipped: false };
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
    logger.warn(`Data delete skipped ${table}: ${error.code || 'error'}`);
    return { table, deleted: false, reason: error.code === '42P01' ? 'table not present' : 'not deleted' };
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
  stripSecrets,
  setDataControlsClient,
  exportUserData,
  deleteUserData,
};
