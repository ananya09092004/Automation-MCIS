const { generateDailyBriefing, sendProactiveNotification } = require('../services/proactiveService');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function runDailyProactive() {
  try {
    // Get all active users
    const { data: users } = await supabase
      .from('user_profiles')
      .select('user_id')
      .eq('is_active', true);

    for (const user of users) {
      const briefing = await generateDailyBriefing(user.user_id);
      
      if (briefing?.needs_attention > 0) {
        const message = `Hey! ${briefing.needs_attention} goals need attention. Check your daily briefing.`;
        await sendProactiveNotification(user.user_id, message, 'attention');
      }

      if (briefing?.suggestions.length > 0) {
        const message = `Smart suggestion: ${briefing.suggestions[0].suggestion}`;
        await sendProactiveNotification(user.user_id, message, 'suggestion');
      }
    }
  } catch (err) {
    console.error('Daily proactive job error:', err);
  }
}

// Run at 9 AM daily
module.exports = { runDailyProactive };