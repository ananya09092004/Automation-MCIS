const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Free tier default — 300 messages/day (GPT/Claude free tier ke range me).
// .env me DAILY_MESSAGE_LIMIT set karke override kar sakti ho.
const DAILY_LIMIT = parseInt(process.env.DAILY_MESSAGE_LIMIT || '300', 10);

// Future paid/pro tier ke liye — req.body.tier: 'pro' bhejoge to ye limit lagegi.
// Abhi kisi request me tier nahi bhejा jaa raha, isliye sab free (300) pe hi rahenge.
const TIER_LIMITS = {
  free: DAILY_LIMIT,
  pro: parseInt(process.env.DAILY_MESSAGE_LIMIT_PRO || '1000', 10),
};

function getLimitForTier(tier) {
  return TIER_LIMITS[tier] || DAILY_LIMIT;
}

async function checkDailyLimit(req, res, next) {
  try {
    const userId = req.body.userId || req.params.userId;
    if (!userId) return next(); // userId nahi mila to block mat karo, aage ki validation handle karegi

    const limit = getLimitForTier(req.body.tier);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    const { data, error } = await supabase
      .from('daily_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('usage_date', today)
      .maybeSingle();

    if (error) throw error;

    const currentCount = data?.count || 0;

    if (currentCount >= limit) {
      return res.status(429).json({
        success: false,
        error: `Daily limit reached (${limit} messages/day). Come back tomorrow.`,
        limitReached: true,
        dailyLimit: limit
      });
    }

    // Increment (upsert) — fire karo lekin response ko block mat karo agar ye slow ho
    await supabase.from('daily_usage').upsert(
      {
        user_id: userId,
        usage_date: today,
        count: currentCount + 1
      },
      { onConflict: 'user_id,usage_date' }
    );

    // Frontend ko remaining count dikhane ke liye header me bhej do (optional use)
    res.setHeader('X-Daily-Remaining', Math.max(0, limit - currentCount - 1));

    next();
  } catch (err) {
    logger.error(`Daily limit check error: ${err.message}`);
    next(); // fail-open — DB issue ki wajah se user ko block mat karo
  }
}

module.exports = checkDailyLimit;