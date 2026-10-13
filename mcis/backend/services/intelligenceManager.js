const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/*
  REASON: Ye file MCIS ki "personality engine" hai
  Har user ke saath alag tarah baat karna seekhti hai
  Time ke saath MCIS smarter hota jaata hai
*/

// User ka communication style detect karo
function detectCommunicationStyle(message) {
  const lower = message.toLowerCase();

  // Hinglish detect karo
  const hinglishWords = ['bhai', 'yaar', 'arre', 'kya', 'hai', 'nahi',
    'haan', 'theek', 'acha', 'matlab', 'kyun', 'kaise',
    'bata', 'de', 'kar', 'ho', 'raha', 'rahi', 'mein'];
  const hinglishCount = hinglishWords.filter(w => lower.includes(w)).length;

  // Casual detect karo
  const casualWords = ['bro', 'dude', 'lol', 'omg', 'wtf', 'tbh',
    'ngl', 'imo', 'btw', 'idk', 'lmk', 'fr'];
  const casualCount = casualWords.filter(w => lower.includes(w)).length;

  // Formal detect karo
  const formalWords = ['please', 'kindly', 'would you', 'could you',
    'i would like', 'regarding', 'furthermore', 'however'];
  const formalCount = formalWords.filter(w => lower.includes(w)).length;

  if (hinglishCount >= 2) return 'hinglish';
  if (casualCount >= 1) return 'casual';
  if (formalCount >= 1) return 'formal';
  return 'neutral';
}

// User ka mood detect karo message se
function detectMood(message) {
  const lower = message.toLowerCase();

  const moods = {
    happy: ['happy', 'excited', 'great', 'awesome', 'amazing', 'love',
      'wonderful', 'fantastic', 'khush', 'mast', 'badhiya'],
    sad: ['sad', 'depressed', 'unhappy', 'upset', 'crying', 'dukhi',
      'pareshan', 'bura lag raha', 'feel bad'],
    stressed: ['stressed', 'anxious', 'worried', 'tension', 'pressure',
      'overwhelmed', 'tensed', 'nervous', 'pareshaan'],
    angry: ['angry', 'frustrated', 'annoyed', 'irritated', 'gussa',
      'mad', 'furious', 'fed up'],
    tired: ['tired', 'exhausted', 'sleepy', 'drained', 'thaka',
      'bored', 'monotonous'],
    motivated: ['motivated', 'focused', 'determined', 'ready', 'lets go',
      'pumped', 'confident', 'inspired']
  };

  for (const [mood, words] of Object.entries(moods)) {
    if (words.some(w => lower.includes(w))) return mood;
  }
  return 'neutral';
}

// Topics of interest extract karo
function extractTopics(message) {
  const lower = message.toLowerCase();
  const topicMap = {
    'AI': ['ai', 'machine learning', 'neural', 'model', 'gpt', 'claude'],
    'coding': ['code', 'programming', 'developer', 'software', 'bug', 'debug'],
    'startups': ['startup', 'business', 'entrepreneur', 'funding', 'pitch'],
    'cricket': ['cricket', 'ipl', 'match', 'wicket', 'batting'],
    'movies': ['movie', 'film', 'netflix', 'series', 'watch'],
    'music': ['music', 'song', 'singer', 'album', 'playlist'],
    'fitness': ['gym', 'workout', 'exercise', 'fitness', 'diet'],
    'travel': ['travel', 'trip', 'tour', 'visit', 'explore'],
    'food': ['food', 'eat', 'restaurant', 'cook', 'recipe'],
    'finance': ['money', 'invest', 'stock', 'crypto', 'savings']
  };

  const foundTopics = [];
  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some(k => lower.includes(k))) {
      foundTopics.push(topic);
    }
  }
  return foundTopics;
}

// Intelligence load karo
async function getUserIntelligence(userId) {
  try {
    const { data } = await supabase
      .from('user_intelligence')
      .select('*')
      .eq('user_id', userId)
      .single();
    return data || null;
  } catch {
    return null;
  }
}

// Intelligence update karo — conversation ke baad
async function updateUserIntelligence(userId, message) {
  try {
    const style = detectCommunicationStyle(message);
    const mood = detectMood(message);
    const topics = extractTopics(message);

    // Pehle check karo record hai ya nahi
    const { data: existing } = await supabase
      .from('user_intelligence')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (existing) {
      // Update karo
      const updatedTopics = [...new Set([
        ...(existing.topics_of_interest || []),
        ...topics
      ])].slice(0, 20); // Max 20 topics

      const updates = {
        last_mood: mood,
        interaction_count: (existing.interaction_count || 0) + 1,
        topics_of_interest: updatedTopics,
        updated_at: new Date().toISOString()
      };

      // Style sirf update karo agar neutral nahi hai
      if (style !== 'neutral') {
        updates.communication_style = style;
      }

      // Language update karo
      if (message.match(/[\u0900-\u097F]/)) {
        updates.preferred_language = 'hindi';
      } else if (updatedTopics.length > 0) {
        updates.preferred_language = 'english';
      }

      await supabase
        .from('user_intelligence')
        .update(updates)
        .eq('user_id', userId);

    } else {
      // Naya record banao
      await supabase
        .from('user_intelligence')
        .insert([{
          user_id: userId,
          communication_style: style,
          preferred_language: 'english',
          last_mood: mood,
          topics_of_interest: topics,
          interaction_count: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]);
    }

    console.log(`Intelligence updated — Style: ${style}, Mood: ${mood}`);
  } catch (err) {
    console.error('Intelligence update error:', err.message);
  }
}

// AI ke liye intelligence context banao
function buildIntelligencePrompt(intelligence) {
  if (!intelligence) return '';

  const style = intelligence.communication_style;
  const mood = intelligence.last_mood;
  const topics = intelligence.topics_of_interest || [];
  const count = intelligence.interaction_count || 0;

  let prompt = `\nUSER INTELLIGENCE (how to talk to this user):\n`;

  // Communication style
  if (style === 'hinglish') {
    prompt += `- Talk in Hinglish (mix of Hindi and English)\n`;
  } else if (style === 'casual') {
    prompt += `- Talk casually and friendly, like a friend\n`;
  } else if (style === 'formal') {
    prompt += `- Talk formally and professionally\n`;
  }

  // Mood based response
  if (mood === 'stressed') {
    prompt += `- User seems stressed — be extra supportive and calm\n`;
  } else if (mood === 'happy') {
    prompt += `- User is in a good mood — be energetic and positive\n`;
  } else if (mood === 'sad') {
    prompt += `- User might be sad — be empathetic and gentle\n`;
  } else if (mood === 'motivated') {
    prompt += `- User is motivated — match their energy\n`;
  }

  // Topics of interest
  if (topics.length > 0) {
    prompt += `- User interests: ${topics.join(', ')} — use relevant examples\n`;
  }

  // Relationship level
  if (count > 50) {
    prompt += `- Long time user (${count} interactions) — be very personal\n`;
  } else if (count > 10) {
    prompt += `- Regular user (${count} interactions) — be friendly\n`;
  } else {
    prompt += `- New user — be welcoming and helpful\n`;
  }

  return prompt;
}

module.exports = {
  getUserIntelligence,
  updateUserIntelligence,
  buildIntelligencePrompt,
  detectMood,
  detectCommunicationStyle
};