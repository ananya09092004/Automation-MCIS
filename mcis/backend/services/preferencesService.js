const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Save preference
async function savePreference(userId, key, value) {
  try {
    const { error } = await supabase
      .from('user_preferences')
      .upsert({
        user_id: userId,
        key,
        value,
        updated_at: new Date().toISOString()
      });

    if (error) throw error;
    logger.info(`Preference saved: ${key} = ${value}`);
    return true;
  } catch (err) {
    logger.error(`Save preference error: ${err.message}`);
    return false;
  }
}

// Get all preferences for user
async function getPreferences(userId) {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('key, value')
      .eq('user_id', userId);

    if (error) throw error;

    const prefs = {};
    data?.forEach(p => {
      prefs[p.key] = p.value;
    });

    logger.info(`Preferences fetched for user: ${Object.keys(prefs).length} items`);
    return prefs;
  } catch (err) {
    logger.error(`Get preferences error: ${err.message}`);
    return {};
  }
}

// Detect preferences from message
function detectPreferences(message) {
  const detected = {};
  const lower = message.toLowerCase();

  // Coding style
  if (lower.includes('class solution') || lower.includes('class-based')) {
    detected['coding_style'] = 'class_based';
  }
  if (lower.includes('functional') || lower.includes('functional approach')) {
    detected['coding_style'] = 'functional';
  }

  // Language preference
  if (lower.includes('python') || lower.includes('in python')) {
    detected['language'] = 'python';
  }
  if (lower.includes('javascript') || lower.includes('js')) {
    detected['language'] = 'javascript';
  }
  if (lower.includes('c++') || lower.includes('cpp')) {
    detected['language'] = 'cpp';
  }

  // Detail level
  if (lower.includes('simple explanation') || lower.includes('easy way')) {
    detected['detail_level'] = 'simple';
  }
  if (lower.includes('detailed') || lower.includes('in depth')) {
    detected['detail_level'] = 'detailed';
  }

  // Code comments
  if (lower.includes('with comments') || lower.includes('explain each line')) {
    detected['comments'] = 'detailed';
  }
  if (lower.includes('no comments') || lower.includes('without comments')) {
    detected['comments'] = 'minimal';
  }

  return detected;
}

// ✅ ADDED: this is the function memoryManager.js was trying to import but never existed here.
// Detects preferences from a message, then saves each one found. Never throws —
// a preference-detection bug should never block the caller (e.g. image/chat responses).
async function detectAndSavePreferences(userId, message) {
  try {
    if (!userId || !message) return;
    const detected = detectPreferences(message);
    const keys = Object.keys(detected);
    if (keys.length === 0) return;

    for (const key of keys) {
      await savePreference(userId, key, detected[key]);
    }
    logger.info(`detectAndSavePreferences: saved ${keys.length} preference(s) for user ${userId}`);
  } catch (err) {
    logger.error(`detectAndSavePreferences error: ${err.message}`);
  }
}

module.exports = {
  savePreference,
  getPreferences,
  detectPreferences,
  detectAndSavePreferences  // ✅ ADDED to exports
};