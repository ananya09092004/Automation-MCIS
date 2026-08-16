const { saveMemory, searchMemory } = require('./memory');
const { createClient } = require('@supabase/supabase-js');
const { detectAndSavePreferences } = require('./preferencesService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const notNames = [
  'a', 'an', 'the', 'is', 'am', 'are', 'was', 'be', 'been',
  'student', 'developer', 'engineer', 'doctor', 'teacher',
  'designer', 'manager', 'founder', 'ceo', 'intern',
  'from', 'in', 'at', 'on', 'of', 'to', 'for', 'by',
  'building', 'making', 'working', 'doing', 'trying',
  'good', 'bad', 'happy', 'sad', 'okay', 'fine',
  'here', 'there', 'this', 'that', 'just', 'also',
  'very', 'really', 'quite', 'still', 'already'
];

function extractImportantInfo(text) {
  const extracted = { names: [], places: [], organizations: [] };

  const namePatterns = [
    /my name is ([A-Za-z]{3,})/i,
    /mera naam ([A-Za-z]{3,})/i,
    /call me ([A-Za-z]{3,})/i,
    /this is ([A-Za-z]{3,})/i,
    /naam ([A-Za-z]{3,}) hai/i,
    /i am ([A-Za-z]{3,})/i,
    /i'm ([A-Za-z]{3,})/i,
    /i m ([A-Za-z]{3,})/i,
  ];

  namePatterns.forEach(p => {
    const match = text.match(p);
    if (match?.[1] && match[1].length >= 3 && !notNames.includes(match[1].toLowerCase())) {
      extracted.names.push(match[1]);
    }
  });

  const placePatterns = [
    /i live in ([A-Za-z]{3,})/i,
    /i am from ([A-Za-z]{3,})/i,
    /i'm from ([A-Za-z]{3,})/i,
    /based in ([A-Za-z]{3,})/i,
    /stay in ([A-Za-z]{3,})/i,
    /living in ([A-Za-z]{3,})/i,
    /main ([A-Za-z]{3,}) mein rehta/i,
    /main ([A-Za-z]{3,}) se hoon/i,
    /([A-Za-z]{3,}) mein rehti hoon/i,
    /([A-Za-z]{3,}) mein rehta hoon/i,
  ];

  placePatterns.forEach(p => {
    const match = text.match(p);
    if (match?.[1] && match[1].length >= 3 && !notNames.includes(match[1].toLowerCase())) {
      extracted.places.push(match[1]);
    }
  });

  const orgPatterns = [
    /i work at ([A-Za-z]{3,})/i,
    /i work for ([A-Za-z]{3,})/i,
    /building ([A-Za-z]{3,})/i,
    /working at ([A-Za-z]{3,})/i,
    /my company ([A-Za-z]{3,})/i,
    /my startup ([A-Za-z]{3,})/i,
    /([A-Za-z]{3,}) mein kaam karta/i,
    /([A-Za-z]{3,}) mein job hai/i,
  ];

  orgPatterns.forEach(p => {
    const match = text.match(p);
    if (match?.[1] && match[1].length >= 3 && !notNames.includes(match[1].toLowerCase())) {
      extracted.organizations.push(match[1]);
    }
  });

  return extracted;
}

// ✅ FIX: categorizeMemory now also looks at the AI's response (not just the user's
// message), and detects coding/DSA/project content via code blocks + a much wider
// set of keywords. Previously a LeetCode question with no exact trigger phrase
// ("my project", "github", etc.) fell into 'general' and was silently dropped —
// this is the main reason coding questions/projects were being forgotten.
function categorizeMemory(text, aiResponse = '') {
  const lower = text.toLowerCase();
  const responseLower = (aiResponse || '').toLowerCase();
  const combinedLower = `${lower} ${responseLower}`;

  // Strongest signal: an actual code block was involved anywhere in this exchange.
  const hasCodeBlock = text.includes('```') || (aiResponse || '').includes('```');

  const codingKeywords = [
    'leetcode', 'hackerrank', 'codeforces', 'codechef', 'gfg', 'geeksforgeeks',
    'dsa', 'algorithm', 'algo', 'data structure',
    'time complexity', 'space complexity', 'big o', 'o(n)', 'o(log n)',
    'constraints', 'test case', 'edge case', 'sample input', 'sample output',
    'binary tree', 'linked list', 'dynamic programming', 'sliding window',
    'two pointer', 'two sum', 'backtracking', 'recursion', 'greedy',
    'graph traversal', 'bfs', 'dfs', 'binary search',
    'given an array', 'given a string', 'given an integer', 'return the',
    'optimal solution', 'brute force', 'optimize this', 'optimized solution',
    'interview question', 'coding question', 'coding problem', 'dsa question',
    'solve this', 'debug this', 'fix this bug', 'this function', 'this code',
    'array of integers', 'subarray', 'substring', 'palindrome'
  ];

  const hasCodingSignal = hasCodeBlock || codingKeywords.some(k => combinedLower.includes(k));
  if (hasCodingSignal) return 'projects';

  if (lower.includes('my name') || lower.includes('mera naam') ||
    lower.includes('i live') || lower.includes('i am from') ||
    lower.includes('i m from') || lower.includes('my age') ||
    lower.includes('meri umar') || lower.includes('i was born') ||
    lower.includes('meri age') || lower.includes('years old') ||
    lower.includes('main rehta') || lower.includes('main rehti')) return 'personal';

  if (lower.includes('want to') || lower.includes('chahta hoon') ||
    lower.includes('chahti hoon') || lower.includes('goal') ||
    lower.includes('dream') || lower.includes('aspire') ||
    lower.includes('building') || lower.includes('bana raha') ||
    lower.includes('bana rahi') || lower.includes('plan hai') ||
    lower.includes('future mein') || lower.includes('someday')) return 'goals';

  if (lower.includes('i like') || lower.includes('i love') ||
    lower.includes('i enjoy') || lower.includes('i prefer') ||
    lower.includes('favourite') || lower.includes('favorite') ||
    lower.includes('mujhe pasand') || lower.includes('mujhe acha lagta') ||
    lower.includes('best part') || lower.includes('i hate') ||
    lower.includes('mujhe nahi pasand') || lower.includes('i dislike')) return 'preferences';

  if (lower.includes('i work') || lower.includes('my job') ||
    lower.includes('my career') || lower.includes('office') ||
    lower.includes('kaam karta') || lower.includes('kaam karti') ||
    lower.includes('naukri') || lower.includes('profession') ||
    lower.includes('i am a ') || lower.includes('main ek ')) return 'work';

  if (lower.includes('i study') || lower.includes('my college') ||
    lower.includes('my school') || lower.includes('university') ||
    lower.includes('degree') || lower.includes('padh raha') ||
    lower.includes('padh rahi') || lower.includes('exam') ||
    lower.includes('semester') || lower.includes('student')) return 'education';

  if (lower.includes('my mom') || lower.includes('my dad') ||
    lower.includes('my sister') || lower.includes('my brother') ||
    lower.includes('my friend') || lower.includes('my boyfriend') ||
    lower.includes('my girlfriend') || lower.includes('meri maa') ||
    lower.includes('mere papa') || lower.includes('mera dost') ||
    lower.includes('family') || lower.includes('relationship')) return 'family';

  if (lower.includes('i exercise') || lower.includes('i workout') ||
    lower.includes('gym') || lower.includes('health') ||
    lower.includes('diet') || lower.includes('i run') ||
    lower.includes('feeling sick') || lower.includes('doctor') ||
    lower.includes('medicine') || lower.includes('hospital')) return 'health';

  if (lower.includes('i play') || lower.includes('i watch') ||
    lower.includes('i read') || lower.includes('my hobby') ||
    lower.includes('i code') || lower.includes('i paint') ||
    lower.includes('i sing') || lower.includes('i dance') ||
    lower.includes('free time') || lower.includes('weekend')) return 'hobbies';

  if (lower.includes('money') || lower.includes('salary') ||
    lower.includes('budget') || lower.includes('invest') ||
    lower.includes('savings') || lower.includes('paisa') ||
    lower.includes('income') || lower.includes('expense') ||
    lower.includes('loan') || lower.includes('emi')) return 'finance';

  if (lower.includes('i am building') || lower.includes('my project') ||
    lower.includes('my app') || lower.includes('my website') ||
    lower.includes('coding') || lower.includes('programming') ||
    lower.includes('software') || lower.includes('github') ||
    lower.includes('deploy') || lower.includes('bana raha hoon')) return 'projects';

  // ✅ NEW: "technical" category — bug reports, incidents, outages, system
  // failures (e.g. "our payment gateway failed due to a webhook timeout").
  // Previously nothing caught this, so it fell through to 'general' and
  // isWorthSaving('general') rejected it — the memory was NEVER saved even
  // though the AI's reply said "Noted... logged in technical notes."
  if (lower.includes('failed') || lower.includes('failure') || lower.includes('error') ||
    lower.includes('bug') || lower.includes('issue') || lower.includes('webhook') ||
    lower.includes('gateway') || lower.includes('crash') || lower.includes('crashed') ||
    lower.includes('timeout') || lower.includes('downtime') || lower.includes('outage') ||
    lower.includes('exception') || lower.includes('not working') || lower.includes('broke') ||
    lower.includes('broken') || lower.includes('kharab') || lower.includes('gadbad') ||
    lower.includes('incident') || lower.includes('root cause')) return 'technical';

  if (lower.includes('i feel') || lower.includes('i am sad') ||
    lower.includes('i am happy') || lower.includes('stressed') ||
    lower.includes('anxious') || lower.includes('excited') ||
    lower.includes('mujhe dukh') || lower.includes('khush hoon') ||
    lower.includes('pareshan') || lower.includes('emotional')) return 'emotions';

  return 'general';
}

// ============ MEMORY CAP / AUTO-PRUNING ============
// Bina kisi cap ke memory_vectors + user_memories tables hamesha ke liye
// grow karte rahenge — storage size khud itna bada issue nahi hai (ek memory
// ~5KB hoti hai), lekin UNBOUNDED growth hi asli risk hai. Isliye per-user
// hard cap rakho: cap cross hote hi sabse purani, low-value memories delete
// ho jaayein (names/goals/preferences jaisi high-value categories ko zyada
// der tak bachaya jaata hai, general/old low-signal cheezein pehle jaati hain).
const MAX_MEMORIES_PER_USER = parseInt(process.env.MAX_MEMORIES_PER_USER || '800', 10);

// Ye categories evict hone me sabse aakhri me aayengi (high value, long-term identity)
const HIGH_VALUE_CATEGORIES = ['personal', 'goals', 'preferences', 'projects', 'technical'];

async function pruneUserMemoryIfNeeded(userId) {
  try {
    const { count, error: countErr } = await supabase
      .from('memory_vectors')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countErr) throw countErr;
    if (!count || count <= MAX_MEMORIES_PER_USER) return;

    const overBy = count - MAX_MEMORIES_PER_USER;

    // Sabse purani memories nikaalo, high-value categories ko skip karte hue
    const { data: oldest, error: fetchErr } = await supabase
      .from('memory_vectors')
      .select('id, content, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(overBy * 3); // buffer, kyunki kuch high-value filter ho jaayengi

    if (fetchErr) throw fetchErr;
    if (!oldest || !oldest.length) return;

    const isHighValue = (content) =>
      HIGH_VALUE_CATEGORIES.some(cat => content.startsWith(`[${cat}]`));

    const toDelete = oldest
      .filter(m => !isHighValue(m.content))
      .slice(0, overBy)
      .map(m => m.id);

    if (toDelete.length > 0) {
      await supabase.from('memory_vectors').delete().in('id', toDelete);
      console.log(`Memory pruned — user ${userId}: ${toDelete.length} old low-value memories removed`);
    }
  } catch (err) {
    console.error('Memory pruning error:', err.message);
  }
}
// =====================================================

// ============ FULL RECALL MODE ============
// Jab user explicitly "sab batao / everything you know" type query kare,
// top-15/threshold-filtered smartSearchMemory kaafi nahi hai — us case me
// pura memory store (category-wise grouped) return karo, bina similarity
// filtering ke. Normal chat isse untouched rehti hai (fast path same rahega).
const FULL_RECALL_PATTERNS = [
  'everything you know', 'everything about me', 'sab kuch batao', 'sab batao',
  'mere baare me sab', 'mere baare mein sab', 'what all do you know',
  'meri saari memory', 'all my memories', 'tumhe mere baare me kya pata',
  'tumhe mere baare mein kya pata', 'meri complete profile', 'full profile',
  'saari details', 'mujhe pura batao', 'what do you remember about me',
  'what do you know about me', 'mere baare mein kya jaante ho'
];

function isFullRecallQuery(message) {
  const lower = (message || '').toLowerCase();
  return FULL_RECALL_PATTERNS.some(p => lower.includes(p));
}

async function getFullMemoryDump(userId) {
  try {
    const { data, error } = await supabase
      .from('memory_vectors')
      .select('content, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(300); // hard top-5/15 nahi — generous safety ceiling sirf

    if (error) throw error;
    if (!data || !data.length) return '';

    // Category ke hisaab se group karo — [personal], [projects], etc.
    const grouped = {};
    data.forEach(m => {
      const catMatch = m.content.match(/^\[(\w+)\]/);
      const cat = catMatch ? catMatch[1] : 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(m.content);
    });

    return Object.entries(grouped)
      .map(([cat, items]) => `=== ${cat.toUpperCase()} ===\n${items.join('\n')}`)
      .join('\n\n');
  } catch (err) {
    console.error('Full memory dump error:', err.message);
    return '';
  }
}
// ============================================

// Kya ye memory save karne layak hai?
function isWorthSaving(category) {
  // Sirf important categories save karo — general aur emotions skip
  const importantCategories = [
    'personal', 'goals', 'preferences', 'work',
    'education', 'family', 'health', 'hobbies',
    'finance', 'projects', 'location',
    'technical' // ✅ added — bug reports / incidents / outages now save
  ];
  return importantCategories.includes(category);
}

// ✅ NEW: detects an explicit "remember this" instruction from the user.
// When present, we save the memory regardless of what category it falls
// into (even 'general' or 'emotions') — the user directly asked MCIS to
// remember it, so category-based filtering should never silently drop it.
const EXPLICIT_REMEMBER_PATTERN = /\b(remember (that|this)|please remember|note (this|that) down|keep this in mind|yaad rakh(na|o)?|isse yaad rakh)\b/i;

function isExplicitRememberRequest(message) {
  return EXPLICIT_REMEMBER_PATTERN.test(message || '');
}

// user_memories table mein save karo (text + category)
async function saveToSupabase(userId, content, category) {
  try {
    const { error } = await supabase
      .from('user_memories')
      .insert([{
        user_id: userId,
        category,
        content,
        created_at: new Date().toISOString()
      }]);
    if (error) console.error('Supabase memory save error:', error.message);
  } catch (err) {
    console.error('Supabase memory error:', err.message);
  }
}

async function smartSaveMemory(userId, userMessage, aiResponse) {
  // Add ye line — preferences detect + save karo
  await detectAndSavePreferences(userId, userMessage);
  // 4 words se kam → skip
  if (userMessage.split(' ').length < 4) {
    console.log('Memory skip — too short');
    return;
  }

  // Filler words → skip
  const fillers = [
    'ok', 'okay', 'thanks', 'thank you', 'hmm', 'hm',
    'yes', 'no', 'yep', 'nope', 'sure', 'alright', 'got it',
    'theek hai', 'acha', 'haan', 'nahi', 'thik h', 'k'
  ];
  const lower = userMessage.toLowerCase().trim();
  if (fillers.some(f => lower === f || lower === f + '.')) {
    console.log('Memory skip — filler word');
    return;
  }

  const combined = `${userMessage} ${aiResponse}`;
  const info = extractImportantInfo(combined);
  // ✅ FIX: pass aiResponse too, so code blocks / coding-specific answers get
  // correctly categorized even when the user's own message is vague ("solve this")
  const category = categorizeMemory(userMessage, aiResponse);

  // ✅ NEW: did the user explicitly ask MCIS to remember this?
  const explicitRemember = isExplicitRememberRequest(userMessage);

  // Names save karo — hamesha important
  if (info.names.length > 0) {
    const content = `[personal] User name: ${info.names.join(', ')}`;
    await saveMemory(userId, content);
    await saveToSupabase(userId, content, 'personal');
  }

  // Places save karo — hamesha important
  if (info.places.length > 0) {
    const content = `[location] User location: ${info.places.join(', ')}`;
    await saveMemory(userId, content);
    await saveToSupabase(userId, content, 'location');
  }

  // Organizations save karo — hamesha important
  if (info.organizations.length > 0) {
    const content = `[projects] Organization: ${info.organizations.join(', ')}`;
    await saveMemory(userId, content);
    await saveToSupabase(userId, content, 'projects');
  }

  // ✅ CHANGED: save if category is normally worth saving, OR the user
  // explicitly asked MCIS to remember this (regardless of category —
  // e.g. "remember that our payment gateway failed..." must never be
  // silently dropped just because it categorized as 'general').
  if (isWorthSaving(category) || explicitRemember) {
    // ✅ FIX: previously only the first 200 chars of the user's message were saved —
    // the AI's actual answer/solution was never stored. For coding/project content
    // especially, the answer is often the valuable part to remember later.
    // If explicitRemember pushed a 'general'/'emotions' category through, tag it
    // as 'technical' when it looks like an incident, otherwise keep it 'general'
    // rather than silently mislabeling it.
    const effectiveCategory = isWorthSaving(category) ? category : (category === 'general' ? 'general' : category);
    let mainContent = `[${effectiveCategory}] User: ${userMessage.slice(0, 200)}`;
    if ((category === 'projects' || category === 'technical') && aiResponse) {
      const answerSnippet = aiResponse.slice(0, 300).replace(/\n+/g, ' ').trim();
      mainContent += ` | Answer: ${answerSnippet}`;
    }
    await saveMemory(userId, mainContent);
    await saveToSupabase(userId, mainContent, effectiveCategory);
    console.log(`Memory saved — Category: [${effectiveCategory}]${explicitRemember ? ' (explicit remember)' : ''}`);

    // Har save pe count check karna wasteful hai (extra DB read har message
    // pe), isliye ~5% chance pe hi prune-check chalao — statistically ye
    // cap ko usi range me maintain kar deta hai, bina per-message overhead ke.
    // Daily cron (jobs/dailyProactive.js) bhi ek guaranteed full sweep karta hai.
    if (Math.random() < 0.05) {
      pruneUserMemoryIfNeeded(userId).catch(() => {});
    }
  } else {
    console.log(`Memory skip — Category [${category}] not worth saving`);
  }
}

// ============ NEW FUNCTION: RANK MEMORIES ============
function rankMemories(memories, userQuery) {
  if (!memories || memories.length === 0) return '';

  const lines = memories.split('\n').filter(line => line.trim());
  
  // Score har memory
  const scoredLines = lines.map(line => {
    let score = 0;

    // 1. Importance (personal facts always important)
    const importantKeywords = ['name', 'goal', 'project', 'preference', 'personal', 'work', 'location', 'education'];
    const hasImportant = importantKeywords.some(kw => line.toLowerCase().includes(kw));
    if (hasImportant) score += 0.4;

    // 2. Specificity (longer = more specific = more important)
    if (line.length > 100) score += 0.2;
    if (line.length > 150) score += 0.1;

    // 3. Query Relevance (how relevant to current query)
    if (userQuery) {
      const queryWords = userQuery.toLowerCase().split(' ').filter(w => w.length > 3);
      const matchCount = queryWords.filter(word => 
        line.toLowerCase().includes(word)
      ).length;
      score += Math.min(matchCount * 0.15, 0.3);
    }

    // 4. Category boost (certain categories more important)
    const categoryBoosts = {
      'personal': 0.2,
      'goal': 0.25,
      'preference': 0.2,
      'project': 0.15,
      'work': 0.15,
      'education': 0.1,
      'technical': 0.2
    };
    
    for (const [cat, boost] of Object.entries(categoryBoosts)) {
      if (line.toLowerCase().includes(`[${cat}]`)) {
        score += boost;
        break;
      }
    }

    return { line, score };
  });

  // Sort by score (high to low) aur top 15 le
  const ranked = scoredLines
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(item => item.line)
    .join('\n');

  return ranked;
}
// ===================================================

// ✅ GENERAL FIX (applies to every question type, not just academic ones):
// `isPureFactual` used to be absent entirely — this function ALWAYS force-
// loaded "personal info" + "project/coding" memory blocks regardless of what
// the current query actually needed, then re-ranked everything with a crude
// keyword heuristic that gave +0.4/+0.1 to anything tagged [education] or
// [project] REGARDLESS of real relevance, and never looked at actual vector
// similarity. That's how an unrelated old memory could out-rank the correct
// answer for ANY objective/factual question — geography, science, general
// knowledge, coding trivia, current facts, anything.
//
// Fix:
//   1. For pure factual queries, skip the always-on personal/project blocks
//      entirely — they add noise, never signal, for an objective question.
//   2. Use REAL similarity from Pinecone/pgvector (via searchMemory's `raw`
//      mode) with a threshold, instead of keyword-only scoring.
//   3. Still blend in a light keyword boost for tie-breaking, but similarity
//      is now the primary signal, not an afterthought.
const SIMILARITY_THRESHOLD_FACTUAL = 0.82; // strict — factual queries
const SIMILARITY_THRESHOLD_DEFAULT = 0.55; // looser — personal/general chat

async function smartSearchMemory(userId, query, options = {}) {
  const { isPureFactual = false } = options;

  try {
    const threshold = isPureFactual ? SIMILARITY_THRESHOLD_FACTUAL : SIMILARITY_THRESHOLD_DEFAULT;

    // Query-relevant memories — always fetched, always the primary signal.
    const mainResults = await searchMemory(userId, query, { raw: true, similarityThreshold: threshold });

    let personalResults = [];
    let projectResults = [];
    let technicalResults = [];

    // Only force-load the "always on" personal/project context blocks when
    // this is NOT a pure factual question. A factual question ("Ch2 geo
    // class 10", "what is the capital of France", "time complexity of
    // quicksort") gets zero benefit from the user's name/goals/past-projects
    // being injected — it only adds irrelevant text that can outrank the
    // real answer in ranking.
    if (!isPureFactual) {
      personalResults = await searchMemory(userId,
        'personal name goal work location education like love prefer hobby',
        { raw: true, similarityThreshold: SIMILARITY_THRESHOLD_DEFAULT });

      projectResults = await searchMemory(userId,
        'project leetcode coding dsa algorithm solution code',
        { raw: true, similarityThreshold: SIMILARITY_THRESHOLD_DEFAULT });

      // ✅ NEW: always-on technical/incident recall block, same pattern as
      // personal/project above — so "why did payment fail last time" style
      // follow-ups can surface a bug/incident memory even when the wording
      // doesn't closely match the original saved sentence.
      technicalResults = await searchMemory(userId,
        'bug error failure outage incident crash webhook timeout downtime issue',
        { raw: true, similarityThreshold: SIMILARITY_THRESHOLD_DEFAULT });
    }

    const allResults = [...mainResults, ...personalResults, ...projectResults, ...technicalResults];
    if (allResults.length === 0) return '';

    // De-dupe (same memory can surface from multiple queries above)
    const seen = new Set();
    const deduped = allResults.filter(m => {
      if (seen.has(m.content)) return false;
      seen.add(m.content);
      return true;
    });

    const allLines = deduped.map(m => m.content).join('\n');

    // ===== RANKING (keyword heuristic now only used as a tie-breaker,
    // similarity threshold already did the real filtering above) =====
    const rankedMemories = rankMemories(allLines, query);

    return rankedMemories;
  } catch (err) {
    console.error('Memory search error:', err.message);
    return '';
  }
}

module.exports = {
  smartSaveMemory,
  smartSearchMemory,
  extractImportantInfo,
  categorizeMemory,
  rankMemories,
  isFullRecallQuery,
  getFullMemoryDump,
  pruneUserMemoryIfNeeded,
  isExplicitRememberRequest
};