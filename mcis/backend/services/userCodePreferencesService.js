const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Detect user's coding preferences from message
function detectCodePreference(message) {
  const msg = message.toLowerCase();

  // Preference keywords
  const preferences = {
    code_only: {
      keywords: ['just code', 'sirf code', 'only code', 'code lang', 'code no explanation', 'bas code'],
      output: 'code_only'
    },
    code_complexity: {
      keywords: ['code and complexity', 'code with analysis', 'complexity', 'time space'],
      output: 'code_with_complexity'
    },
    interview_ready: {
      keywords: ['interview', 'interview ready', 'interview prep', 'for interview'],
      output: 'interview_ready'
    },
    full_explanation: {
      keywords: ['explain', 'detailed', 'full', 'everything', 'samjhao', 'sikhao'],
      output: 'full_explanation'
    },
    fix_only: {
      keywords: ['fix', 'fix my code', 'repair', 'debug', 'bug'],
      output: 'fix_only'
    },
    quick: {
      keywords: ['quick', 'fast', 'asap', 'hurry', 'jaldi'],
      output: 'code_only'
    }
  };

  // Check which preference matches
  for (const [pref, data] of Object.entries(preferences)) {
    if (data.keywords.some(kw => msg.includes(kw))) {
      logger.info(`User preference detected: ${data.output}`);
      return data.output;
    }
  }

  // Default: balanced (code + basic explanation)
  return 'balanced';
}

// Get user's saved code preferences
async function getUserCodePreferences(userId) {
  try {
    const { data, error } = await supabase
      .from('user_coding_profile')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    return {
      output_format: data?.preferred_code_output || 'balanced',
      include_complexity: data?.include_analysis || true,
      include_explanation: data?.explanation_style !== 'none',
      include_tests: data?.include_test_cases || false,
      response_length: data?.preferred_response_length || 'medium' // short, medium, long
    };
  } catch (err) {
    logger.error(`Get preferences error: ${err.message}`);
    return {
      output_format: 'balanced',
      include_complexity: true,
      include_explanation: true,
      include_tests: false,
      response_length: 'medium'
    };
  }
}

// Save user code preference
async function saveCodePreference(userId, preference) {
  try {
    const { error } = await supabase
      .from('user_coding_profile')
      .update({
        preferred_code_output: preference,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) throw error;
    logger.info(`Preference saved: ${preference}`);
    return { success: true };
  } catch (err) {
    logger.error(`Save preference error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  detectCodePreference,
  getUserCodePreferences,
  saveCodePreference
};