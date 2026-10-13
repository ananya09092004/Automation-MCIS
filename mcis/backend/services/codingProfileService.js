const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Initialize coding profile from user data
async function initializeCodingProfile(userId, userData) {
  try {
    // Detect from messages/history
    const language = detectLanguage(userData.messages || []);
    const style = detectCodingStyle(userData.messages || []);
    const weakAreas = detectWeakAreas(userData.messages || []);

    const { data, error } = await supabase
      .from('user_coding_profile')
      .upsert([{
        user_id: userId,
        preferred_language: language,
        code_structure: style,
        weak_areas: weakAreas,
        strong_areas: ['problem-solving'],
        learning_pace: 'medium',
        interview_prep: userData.interview_prep || false,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    logger.info(`Coding profile created for ${userId}`);
    return { success: true, profile: data[0] };
  } catch (err) {
    logger.error(`Initialize profile error: ${err.message}`);
    return { success: false };
  }
}

// Detect preferred language
function detectLanguage(messages) {
  const combined = messages.join(' ').toLowerCase();
  
  const languages = {
    python: ['python', '.py', 'def ', 'import ', 'class'],
    java: ['java', '.java', 'public class', 'void main'],
    javascript: ['javascript', '.js', 'function', 'const', 'async'],
    cpp: ['c++', '.cpp', '#include', 'int main()'],
  };

  let scores = {};
  for (const [lang, keywords] of Object.entries(languages)) {
    scores[lang] = keywords.filter(kw => combined.includes(kw)).length;
  }

  const best = Object.keys(scores).reduce((a, b) => 
    scores[a] > scores[b] ? a : b
  );

  return best || 'python';
}

// Detect coding style preference
function detectCodingStyle(messages) {
  const combined = messages.join(' ').toLowerCase();
  
  const oop = ['class', 'object', 'inheritance', 'polymorphism'];
  const functional = ['lambda', 'map', 'filter', 'reduce'];
  
  const oopScore = oop.filter(w => combined.includes(w)).length;
  const funcScore = functional.filter(w => combined.includes(w)).length;

  return oopScore > funcScore ? 'OOP' : 'Functional';
}

// Detect weak areas
function detectWeakAreas(messages) {
  const combined = messages.join(' ').toLowerCase();
  
  const weakIndicators = {
    graphs: ['graph', 'confused', 'struggled', 'stuck'],
    dp: ['dynamic programming', 'hard', 'confusing'],
    strings: ['string', 'regex', 'pattern'],
    sorting: ['sort', 'algorithm'],
    trees: ['tree', 'bst']
  };

  const weak = [];
  for (const [area, keywords] of Object.entries(weakIndicators)) {
    if (keywords.some(kw => combined.includes(kw))) {
      weak.push(area);
    }
  }

  return weak.length > 0 ? weak : ['graphs'];
}

// Get user coding profile
async function getCodingProfile(userId) {
  try {
    const { data, error } = await supabase
      .from('user_coding_profile')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  } catch (err) {
    logger.error(`Get profile error: ${err.message}`);
    return null;
  }
}

// Update profile based on user feedback
async function updateCodingProfile(userId, feedback) {
  try {
    const profile = await getCodingProfile(userId);
    
    if (!profile) return { success: false };

    const updates = {
      problems_solved: (profile.problems_solved || 0) + 1,
      success_rate: feedback.success ? 1.0 : 0.5,
      updated_at: new Date().toISOString()
    };

    if (feedback.preferred_language) {
      updates.preferred_language = feedback.preferred_language;
    }

    const { error } = await supabase
      .from('user_coding_profile')
      .update(updates)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  } catch (err) {
    logger.error(`Update profile error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  initializeCodingProfile,
  getCodingProfile,
  updateCodingProfile
};