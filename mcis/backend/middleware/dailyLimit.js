const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Free tier default — 300 messages/day (GPT/Claude free tier ke range me).
// .env me DAILY_MESSAGE_LIMIT set karke override kar sakti ho.
const DAILY_LIMIT = parseInt(process.env.DAILY_MESSAGE_LIMIT || '300', 10);

// Future paid/pro tier ke liye limits -- see resolveServerSideTier() below.
// Repo-wide search found no subscription/billing table or column
// anywhere in this codebase (no Stripe/payment webhook, no `tier`
// column on any user/workspace record) -- so today there IS no real
// paid tier yet; every account is genuinely 'free'. That used to be
// enforced by convention only ("abhi kisi request me tier nahi bheja
// jaa raha"), not by the server, which meant a client could simply
// send tier: "pro" in the request body and get the higher limit with
// zero payment or entitlement check. TIER_LIMITS itself is unchanged
// (same two numbers); what changed is WHERE the tier comes from.
const TIER_LIMITS = {
  free: DAILY_LIMIT,
  pro: parseInt(process.env.DAILY_MESSAGE_LIMIT_PRO || '1000', 10),
};

function getLimitForTier(tier) {
  return TIER_LIMITS[tier] || DAILY_LIMIT;
}

// Server-side authoritative tier lookup. There is no subscription/
// billing system wired into this backend yet (confirmed: no table, no
// payment provider, no admin-set entitlement anywhere), so the only
// honest authoritative answer today is 'free' for everyone -- this
// function is NOT a fake entitlement check, it's the single place a
// real one gets wired in later (e.g. a Supabase `workspace_billing`
// lookup) without touching the request-trusting code path again.
// Critically, it never reads req.body/req.query/req.params: a client
// cannot upgrade itself by sending a different value, because nothing
// here looks at anything the client sent.
async function resolveServerSideTier(_userId) {
  return 'free';
}

async function checkDailyLimit(req, res, next) {
  try {
    // Identity for quota purposes must come from the authenticated
    // request context (req.user.uid, set by middleware/auth.js's
    // Firebase verification), never read as-is from a client-supplied
    // body/params field -- otherwise an attacker could either omit
    // userId to skip the quota check for that request entirely, or
    // supply a DIFFERENT user's id to burn through that victim's daily
    // allowance. req.body.userId / req.params.userId are kept only as a
    // fallback for the same dev-only unauthenticated-API mode every
    // other route in this app already tolerates (req.user is never set
    // in that mode) -- in normal operation the global auth middleware
    // has already rejected any request whose body/params userId doesn't
    // match the authenticated caller, so this fallback never lets an
    // attacker substitute someone else's id.
    const userId = req.user?.uid || req.body.userId || req.params.userId;
    if (!userId) return next(); // userId nahi mila to block mat karo, aage ki validation handle karegi

    const tier = await resolveServerSideTier(userId);
    const limit = getLimitForTier(tier);
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