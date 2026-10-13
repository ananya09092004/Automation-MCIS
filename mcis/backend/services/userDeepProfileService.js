const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Detect learning style from messages
function detectLearningStyle(messages) {
  const combined = messages.join(' ').toLowerCase();
  
  const styleIndicators = {
    visual: ['diagram', 'visualize', 'picture', 'show', 'see', 'image', 'color', 'graph'],
    auditory: ['listen', 'hear', 'sound', 'voice', 'explain', 'discuss', 'podcast'],
    kinesthetic: ['try', 'practice', 'hands-on', 'build', 'do', 'experience', 'feel'],
    reading: ['read', 'documentation', 'article', 'book', 'text', 'write', 'prose']
  };

  const scores = {};
  for (const [style, keywords] of Object.entries(styleIndicators)) {
    scores[style] = keywords.filter(kw => combined.includes(kw)).length;
  }

  const dominant = Object.keys(scores).reduce((a, b) => 
    scores[a] > scores[b] ? a : b
  );

  return dominant || 'mixed';
}

// Detect personality type (simplified MBTI)
function detectPersonality(messages, preferences) {
  const combined = messages.join(' ').toLowerCase();
  
  // Extroverted vs Introverted
  const extroIndicators = ['team', 'collaborate', 'discuss', 'group', 'together'];
  const introIndicators = ['alone', 'solo', 'independent', 'self-paced', 'quiet'];
  const extraversion = extroIndicators.filter(w => combined.includes(w)).length >
                       introIndicators.filter(w => combined.includes(w)).length ? 'E' : 'I';

  // Sensing vs Intuition
  const sensingIndicators = ['practical', 'specific', 'concrete', 'real-world', 'example'];
  const intuitionIndicators = ['theory', 'abstract', 'big-picture', 'concept', 'idea'];
  const intuition = intuitionIndicators.filter(w => combined.includes(w)).length >
                    sensingIndicators.filter(w => combined.includes(w)).length ? 'N' : 'S';

  // Thinking vs Feeling
  const thinkingIndicators = ['logic', 'reason', 'analyze', 'systematic', 'objective'];
  const feelingIndicators = ['value', 'impact', 'help', 'meaning', 'passion'];
  const thinking = thinkingIndicators.filter(w => combined.includes(w)).length >
                   feelingIndicators.filter(w => combined.includes(w)).length ? 'T' : 'F';

  // Judging vs Perceiving
  const judgingIndicators = ['plan', 'structure', 'schedule', 'organized', 'deadline'];
  const perceivingIndicators = ['flexible', 'spontaneous', 'adapt', 'fluid', 'open'];
  const judging = judgingIndicators.filter(w => combined.includes(w)).length >
                  perceivingIndicators.filter(w => combined.includes(w)).length ? 'J' : 'P';

  return extraversion + intuition + thinking + judging;
}

// Detect risk tolerance
function detectRiskTolerance(messages) {
  const combined = messages.join(' ').toLowerCase();
  
  const highRiskIndicators = ['startup', 'ambitious', 'risk', 'leap', 'bold', 'aggressive'];
  const lowRiskIndicators = ['stable', 'secure', 'safe', 'careful', 'conservative'];

  const highRisk = highRiskIndicators.filter(w => combined.includes(w)).length;
  const lowRisk = lowRiskIndicators.filter(w => combined.includes(w)).length;

  if (highRisk > lowRisk) return 'high';
  if (lowRisk > highRisk) return 'low';
  return 'medium';
}

// Detect motivation drivers
function detectMotivationDrivers(messages) {
  const combined = messages.join(' ').toLowerCase();
  
  const drivers = {
    mastery: ['master', 'expert', 'skill', 'perfect', 'improve', 'best'],
    impact: ['help', 'change', 'affect', 'difference', 'meaningful', 'purpose'],
    autonomy: ['independent', 'control', 'own', 'freedom', 'choose', 'self'],
    social: ['team', 'people', 'community', 'network', 'together', 'collaboration'],
    financial: ['money', 'salary', 'income', 'wealth', 'investment', 'profit']
  };

  const detected = [];
  for (const [driver, keywords] of Object.entries(drivers)) {
    if (keywords.some(kw => combined.includes(kw))) {
      detected.push(driver);
    }
  }

  return detected.length > 0 ? detected : ['growth'];
}

// Create or update user deep profile
async function createOrUpdateProfile(userId, detectedData) {
  try {
    const { data, error } = await supabase
      .from('user_deep_profile')
      .upsert([{
        user_id: userId,
        learning_style: detectedData.learning_style,
        personality_type: detectedData.personality_type,
        risk_tolerance: detectedData.risk_tolerance,
        motivation_drivers: detectedData.motivation_drivers,
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    logger.info(`Deep profile created/updated for ${userId}`);
    return { success: true, profile: data[0] };
  } catch (err) {
    logger.error(`Create profile error: ${err.message}`);
    return { success: false };
  }
}

// Get user deep profile
async function getUserDeepProfile(userId) {
  try {
    const { data, error } = await supabase
      .from('user_deep_profile')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  } catch (err) {
    logger.error(`Get profile error: ${err.message}`);
    return null;
  }
}

// Analyze user from recent messages
async function analyzeUserFromMessages(userId, recentMessages) {
  try {
    const messageTexts = recentMessages.map(m => m.message);
    
    const analysis = {
      learning_style: detectLearningStyle(messageTexts),
      personality_type: detectPersonality(messageTexts, {}),
      risk_tolerance: detectRiskTolerance(messageTexts),
      motivation_drivers: detectMotivationDrivers(messageTexts)
    };

    const result = await createOrUpdateProfile(userId, analysis);
    logger.info(`User analysis complete: ${userId}`);
    return result;
  } catch (err) {
    logger.error(`Analyze user error: ${err.message}`);
    return { success: false };
  }
}

// Get profile context for prompts
async function getProfileContext(userId) {
  try {
    const profile = await getUserDeepProfile(userId);
    
    if (!profile) return '';

    const context = `USER PROFILE:
Learning style: ${profile.learning_style}
Personality: ${profile.personality_type}
Risk tolerance: ${profile.risk_tolerance}
Motivations: ${profile.motivation_drivers?.join(', ') || 'growth'}`;

    return context;
  } catch (err) {
    logger.error(`Get profile context error: ${err.message}`);
    return '';
  }
}

module.exports = {
  detectLearningStyle,
  detectPersonality,
  detectRiskTolerance,
  detectMotivationDrivers,
  createOrUpdateProfile,
  getUserDeepProfile,
  analyzeUserFromMessages,
  getProfileContext
};