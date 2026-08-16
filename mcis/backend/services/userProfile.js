const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getUserProfile(userId) {
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();
    return data || null;
  } catch {
    return null;
  }
}

async function updateUserProfile(userId, updates) {
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (data) {
      await supabase
        .from('user_profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    } else {
      await supabase
        .from('user_profiles')
        .insert([{ user_id: userId, ...updates, created_at: new Date().toISOString() }]);
    }
    console.log('Profile updated ✅');
  } catch (err) {
    console.error('Profile update error:', err.message);
  }
}

async function extractAndUpdateProfile(userId, userMessage, aiResponse) {
  try {
    const combined = `${userMessage} ${aiResponse}`.toLowerCase();
    const updates = {};

    const nameMatch = combined.match(/my name is ([a-z]+)|mera naam ([a-z]+) hai/i);
    if (nameMatch) updates.name = nameMatch[1] || nameMatch[2];

    const cityMatch = combined.match(/i live in ([a-z]+)|i am from ([a-z]+)|main ([a-z]+) mein rehta/i);
    if (cityMatch) updates.city = cityMatch[1] || cityMatch[2] || cityMatch[3];

    const jobMatch = combined.match(/i am a ([a-z]+)|i work as ([a-z]+)/i);
    if (jobMatch) updates.profession = jobMatch[1] || jobMatch[2];

    if (Object.keys(updates).length > 0) {
      await updateUserProfile(userId, updates);
    }
  } catch (err) {
    console.error('Extract profile error:', err.message);
  }
}

module.exports = { getUserProfile, updateUserProfile, extractAndUpdateProfile };