const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Ye queries pe KABHI search mat karo â€” sirf jab user APNE MCIS ke baare mein pooche
const NO_SEARCH_PATTERNS = [
  'my project', 'my app', 'my assistant', 'you have', 'you know',
  'what are you', 'who are you', 'what can you', 'your qualities',
  'your features', 'your technology', 'your tech stack', 'about you',
  'what do you', 'how are you', 'tell me about yourself', 'introduce yourself',
  'mera project', 'meri app', 'tum kya', 'tumhare paas', 'tum kaise',
  'apne baare mein', 'what makes you', 'how do you work', 'your capabilities',
  'your memory', 'your stack', 'built with', 'made with'
];

// MCIS ko specifically refer karne wale patterns â€” ye sirf tab apply honge
// jab context clearly APNA app ho
const MCIS_SELF_PATTERNS = [
  'mcis ke features', 'mcis ki technology', 'mcis mein kya hai',
  'mcis ko improve', 'my mcis', 'our mcis', 'mera mcis',
  'mcis project', 'mcis app', 'mcis ka', 'mcis ki',
  'mcis me kya', 'mcis me add', 'mcis kaise kaam',
  'what does mcis do', 'how does mcis work', 'mcis features',
  'mcis technology', 'mcis tech stack', 'mcis capabilities'
];

// Ye queries pe search ZAROOR karo
const FORCE_SEARCH_PATTERNS = [
  'latest', 'current', 'today', 'news', 'price', 'stock', 'weather',
  'recently', 'just released', 'new version', 'update', '2024', '2025',
  'right now', 'live', 'happening', 'trending', 'breaking'
];

// ✅ GENERAL FIX (not just "Ch2 geo class 10" — EVERY objective/factual
// question type): a bare factual question must NEVER pull in unrelated
// personal/project memory as if it were the source of truth. This covers
// academic/curriculum lookups, general knowledge, definitions, science,
// geography, history, coding concepts, current facts — anything with a
// single objectively-correct answer that does not depend on who's asking.
//
// Two independent signals, checked together:
//   1. Does the query LOOK objective/factual (structure + academic markers)?
//   2. Does the query reference the user personally (my/mera/I/main...)?
// Only when (1) is true AND (2) is false do we treat it as pure factual —
// safe to answer from verified knowledge alone, memory optional/off.

// Structural markers of an objective-fact question — works across ANY
// subject/domain, not a hardcoded list of school subjects.
const FACTUAL_QUESTION_STRUCTURES = [
  /^\s*(what|who|when|where|which|how many|how much)\b/i,   // "what is...", "who was...", "how many..."
  /^\s*(define|explain|meaning of|full form of)\b/i,        // "define X", "full form of X"
  /\bcapital of\b/i, /\bpopulation of\b/i, /\bsynonym of\b/i,
  /\bch(apter)?\.?\s?\d+\b/i,                              // "chapter 2", "ch2"
  /\bclass\s?\d+\b/i,                                      // "class 10"
  /\bncert\b/i, /\bcbse\b/i, /\bsyllabus\b/i,
  /\b(formula|theorem|definition|algorithm)\s+(of|for)\b/i,
  /\b(atomic number|boiling point|melting point|square root|time complexity)\b/i,
];

// Curriculum/academic subject words — still useful as a secondary signal
// (e.g. a lone "geography" or "physics" mention), kept broad on purpose.
const ACADEMIC_SUBJECT_WORDS = [
  /\b(geography|geo|history|civics|economics|physics|chemistry|biology|maths?|science|hindi|english|sst)\b/i,
];

// Ownership/personal-reference words — if these ARE present, the query is
// no longer "bare" (e.g. "what did I write in my chapter 2 notes", "explain
// MY code", "what's my strategy" genuinely needs memory), so the override
// should not apply.
const PERSONAL_REFERENCE_PATTERNS = [
  /\bmy\b/i, /\bmera\b/i, /\bmeri\b/i, /\bhumara\b/i, /\bhamara\b/i,
  /\bi\s/i, /\bmain\s/i, /\bmujhe\b/i, /\bmere\b/i, /\bour\b/i, /\bwe\b/i,
];

// ✅ NEW (fix for the Razorpay/"what happened" bug): a question shaped like
// "what/who/when happened/failed/broke..." is an EVENT or INCIDENT report,
// not an objective trivia fact. "What happened with Razorpay on 10th July"
// has the same surface structure as "what is the capital of France", but
// it does NOT have one universally-correct, memory-independent answer — it
// could easily be about the user's OWN system/integration/company, which is
// exactly what memory exists to answer correctly. So: if the query contains
// any event/incident word, it is NEVER treated as pure-factual, no matter
// what structural pattern it also matches. This is checked before the
// structural/academic signals below, and short-circuits them.
const EVENT_INCIDENT_WORDS = [
  /\bhappened\b/i, /\bhappening\b/i, /\bfailed\b/i, /\bfailure\b/i,
  /\bwent wrong\b/i, /\bissue\b/i, /\bproblem\b/i, /\bbug\b/i,
  /\bcrash(ed)?\b/i, /\bdown(time)?\b/i, /\boutage\b/i, /\berror\b/i,
  /\bbroke\b/i, /\bbroken\b/i, /\bwebhook\b/i, /\btimeout\b/i,
  /\bincident\b/i, /\bnot working\b/i, /\bstopped working\b/i,
];

function hasEventIncidentSignal(message) {
  return EVENT_INCIDENT_WORDS.some((p) => p.test(message));
}

function isPureFactualQuery(message, recentContext = '') {
  // Event/incident-shaped questions are never pure-factual — see comment above.
  if (hasEventIncidentSignal(message)) return false;

  const hasFactualStructure = FACTUAL_QUESTION_STRUCTURES.some((p) => p.test(message));
  const hasAcademicSubject = ACADEMIC_SUBJECT_WORDS.some((p) => p.test(message));
  const hasFactualSignal = hasFactualStructure || hasAcademicSubject;

  // ✅ NEW: personal-reference check now also looks at the last couple of
  // turns, not just the current message. Previously "our Razorpay webhook
  // failed..." (personal signal present) followed by a bare "What happened
  // with Razorpay on 10th July?" (no possessive word at all) lost that
  // context entirely — the second message alone had no "our"/"my", so it
  // was wrongly classified as pure-factual and the model was told to
  // ignore memory. Checking recent history prevents this class of bug for
  // any short follow-up question that omits the possessive the second time.
  const hasPersonalSignal =
    PERSONAL_REFERENCE_PATTERNS.some((p) => p.test(message)) ||
    (recentContext && PERSONAL_REFERENCE_PATTERNS.some((p) => p.test(recentContext)));

  return hasFactualSignal && !hasPersonalSignal;
}

// Kept as an alias so any existing references / tests using the old,
// narrower name keep working.
const isPureAcademicFactual = isPureFactualQuery;

function shouldSearch(message) {
  const lower = message.toLowerCase();

  // Pehle check karo â€” kya ye user ka APNA MCIS hai?
  // "my mcis", "our mcis", "mcis project" etc â€” ye sab apna app hai
  const isSelfMCIS = MCIS_SELF_PATTERNS.some(p => lower.includes(p));
  if (isSelfMCIS) return false;

  // Kya ye sirf "you/your" ke baare mein hai â€” apna assistant
  const isAboutSelf = NO_SEARCH_PATTERNS.some(p => lower.includes(p));
  if (isAboutSelf) return false;

  // FIX: "what am I building with MCIS?" has no possessive word ("my",
  // "our"...) but IS clearly self-referential ("I", "am I", "main"). The
  // old list only caught possessives, so this triggered an unnecessary
  // web search for a pure personal-recall question. Added first-person
  // pronoun/verb patterns alongside the possessives.
  if (lower.includes('mcis')) {
    const ownershipWords = [
      'my ', 'our ', 'mera ', 'meri ', 'your ', 'this ', 'the app', 'tumhara',
      'i ', "i'm", 'am i', 'main ', 'mujhe', 'mai ',
    ];
    const hasOwnership = ownershipWords.some(w => lower.includes(w));
    if (!hasOwnership) {
      // "what is mcis", "mcis company", "mcis organization" etc -- search karo
      return true;
    }
    return false;
  }

  // Force search patterns
  const forceSearch = FORCE_SEARCH_PATTERNS.some(p => lower.includes(p));
  if (forceSearch) return true;

  return false; // Default: search mat karo
}

async function planQuery(userMessage, userHistory = [], userProfile = null) {
  try {
    const recentContext = userHistory.slice(-3)
      .map(h => `User: ${h.message?.slice(0, 100)}`)
      .join('\n');

    const profileHint = userProfile
      ? `User is: ${userProfile.profession || 'unknown'}, from ${userProfile.city || 'unknown'}`
      : '';

    const completion = await groq.chat.completions.create({ reasoning_effort: 'none',
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'system',
          content: `You are an advanced AI query analyzer. Deeply understand what the user truly needs and create a precise execution plan.

CRITICAL RULE FOR needs_search:
- needs_search = FALSE for: personal questions, questions about "you/MCIS", memory-based questions, coding help, general knowledge, explanations, project questions
- needs_search = TRUE ONLY for: current events, breaking news, live prices/stocks, weather, very recent releases (last few weeks)
- When in doubt â†’ needs_search = FALSE

Analyze the query and return ONLY a valid JSON object:

{
  "intent": string,
  "sub_intent": string,
  "topic": string,
  "topic_domain": string,
  "user_goal": string,
  "emotional_tone": string,
  "needs_memory": boolean,
  "memory_type": array,
  "memory_query": string,
  "needs_search": boolean,
  "search_query": string,
  "needs_files": boolean,
  "needs_reasoning": boolean,
  "needs_step_by_step": boolean,
  "needs_code": boolean,
  "needs_examples": boolean,
  "response_format": string,
  "response_length": string,
  "complexity": string,
  "language": string,
  "confidence": number,
  "fallback_intent": string,
  "execution_steps": array
}

INTENT OPTIONS:
coding, debugging, learning, writing, research, project,
startup, career, personal, emotional, planning, analysis,
comparison, creative, general,memory_delete

SUB_INTENT OPTIONS:
coding â†’ [write_code, explain_code, optimize_code, review_code, debug_project]
learning â†’ [explain_concept, give_resources, create_roadmap, quiz_me]
writing â†’ [write_essay, write_email, write_blog, proofread, summarize]
research â†’ [find_info, compare_options, deep_dive, fact_check]
project â†’ [improve_project, architecture, add_feature, debug_project, roadmap]
personal â†’ [vent_feelings, seek_advice, motivation, life_decision]
planning â†’ [daily_plan, project_plan, goal_setting, schedule]

MEMORY RULES:
needs_memory = true if:
- User says "my", "our", "I", "we", "mera", "humara", "meri"
- Mentions personal projects, past work, goals
- Asks follow-up questions
- Asks about "you/MCIS" â€” needs memory to answer accurately
- Asks "what happened / what failed / what went wrong / what broke" about
  ANYTHING — these are incident-style questions that are very often about
  the user's own systems/projects, so memory must be checked, never skipped.

needs_memory = FALSE for bare academic/curriculum factual lookups — chapter
numbers, class numbers, NCERT/CBSE subjects, definitions, formulas — UNLESS
the query also contains an ownership word ("my", "mera", "I"). These are
objective facts. Injecting unrelated personal/project memory into a factual
answer is a critical bug — it must never happen.
Example: "Ch2 geo class 10" → needs_memory: false (pure factual lookup).
Example: "what did I write in my geo ch2 notes" → needs_memory: true (personal reference).
Example: "what happened with Razorpay on 10th July" → needs_memory: true
  (incident/event question — could be about the user's own integration;
  never treat this like a trivia fact).

MEMORY_TYPE options:
[project, learning, goals, preferences, past_chats, technical_notes, roadmap, personal, work, education, health, finance, hobbies]

MEMORY_QUERY: Optimized search query for Pinecone â€” extract key concepts

RESPONSE FORMAT:
[prose, bullet_points, numbered_steps, code_block, table, mixed]

RESPONSE LENGTH:
simple factual â†’ short
explanation/learning â†’ medium  
project/architecture/analysis â†’ long
comprehensive guide â†’ very_long

COMPLEXITY: [simple, medium, complex, expert]

LANGUAGE detection:
- Hindi script (à¤¦à¥‡à¤µà¤¨à¤¾à¤—à¤°à¥€) â†’ hindi
- Mix of Hindi words + English â†’ hinglish
- Pure English â†’ english
- Hinglish words: kya, hai, karo, tha, mein, pe, se, nahi, haan, aur, toh, agar, matlab, yaar, bhai, etc.

EXECUTION_STEPS â€” only include what's needed:
["retrieve_memory", "search_web", "load_files", "build_context", "generate_answer"]

EXAMPLES:

Query: "What are your qualities that Claude and GPT don't have?"
{
  "intent": "general",
  "sub_intent": "find_info",
  "topic": "MCIS",
  "topic_domain": "technology",
  "user_goal": "understand_capabilities",
  "emotional_tone": "curious",
  "needs_memory": true,
  "memory_type": ["project", "technical_notes"],
  "memory_query": "MCIS features capabilities memory technology",
  "needs_search": false,
  "search_query": "",
  "needs_files": false,
  "needs_reasoning": false,
  "needs_step_by_step": false,
  "needs_code": false,
  "needs_examples": true,
  "response_format": "mixed",
  "response_length": "long",
  "complexity": "medium",
  "language": "english",
  "confidence": 0.97,
  "fallback_intent": "general",
  "execution_steps": ["retrieve_memory", "build_context", "generate_answer"]
}

Query: "What is the latest React version?"
{
  "intent": "research",
  "sub_intent": "find_info",
  "topic": "React",
  "topic_domain": "technology",
  "user_goal": "get_answer",
  "emotional_tone": "curious",
  "needs_memory": false,
  "memory_type": [],
  "memory_query": "",
  "needs_search": true,
  "search_query": "React latest version 2025",
  "needs_files": false,
  "needs_reasoning": false,
  "needs_step_by_step": false,
  "needs_code": false,
  "needs_examples": false,
  "response_format": "prose",
  "response_length": "short",
  "complexity": "simple",
  "language": "english",
  "confidence": 0.99,
  "fallback_intent": "general",
  "execution_steps": ["search_web", "generate_answer"]
}

Query: "forget that I like painting"
{
  "intent": "memory_delete",
  "sub_intent": "forget_fact",
  "topic": "painting preference",
  "topic_domain": "personal_life",
  "user_goal": "delete_memory",
  "emotional_tone": "neutral",
  "needs_memory": false,
  "memory_type": [],
  "memory_query": "",
  "needs_search": false,
  "search_query": "",
  "needs_files": false,
  "needs_reasoning": false,
  "needs_step_by_step": false,
  "needs_code": false,
  "needs_examples": false,
  "response_format": "prose",
  "response_length": "short",
  "complexity": "simple",
  "language": "english",
  "confidence": 0.99,
  "fallback_intent": "general",
  "execution_steps": ["delete_memory", "confirm_deletion"]
}

Query: "yaar bahut stressed hoon aaj"
{
  "intent": "emotional",
  "sub_intent": "vent_feelings",
  "topic": "stress",
  "topic_domain": "personal_life",
  "user_goal": "vent_feelings",
  "emotional_tone": "stressed",
  "needs_memory": true,
  "memory_type": ["personal", "goals", "preferences"],
  "memory_query": "stress personal life wellbeing feelings",
  "needs_search": false,
  "search_query": "",
  "needs_files": false,
  "needs_reasoning": false,
  "needs_step_by_step": false,
  "needs_code": false,
  "needs_examples": false,
  "response_format": "prose",
  "response_length": "medium",
  "complexity": "simple",
  "language": "hinglish",
  "confidence": 0.97,
  "fallback_intent": "personal",
  "execution_steps": ["retrieve_memory", "build_context", "generate_answer"]
}

Return ONLY the JSON object. No markdown, no explanation, no extra text.`
        },
        {
          role: 'user',
          content: `${profileHint ? `Profile: ${profileHint}\n` : ''}${recentContext ? `Recent context:\n${recentContext}\n` : ''}Query: "${userMessage}"`
        }
      ],
      max_tokens: 600,
      temperature: 0.1
    });

    const text = completion.choices[0].message.content.trim();
    const cleaned = text.replace(/```json|```/g, '').trim();
    const plan = JSON.parse(cleaned);

    // Safety override â€” MCIS/personal queries pe search band karo
    if (shouldSearch(userMessage) === false && plan.needs_search) {
      plan.needs_search = false;
      plan.search_query = '';
      plan.execution_steps = plan.execution_steps?.filter(s => s !== 'search_web');
      console.log('Search overridden â€” personal/MCIS query detected');
    }

    // Force search agar zaruri ho
    if (shouldSearch(userMessage) === true && !plan.needs_search) {
      plan.needs_search = true;
      plan.execution_steps = ['search_web', ...(plan.execution_steps || [])];
      console.log('Search forced â€” real-time data needed');
    }

    // GENERAL FIX -- pure factual query override (applies to EVERY question
    // type: academic, general knowledge, definitions, science, coding facts,
    // history, current facts -- not just curriculum lookups). Even if the
    // planner LLM guessed needs_memory=true, a bare factual question with no
    // personal-reference words gets memory forcibly turned off here. This is
    // the hard backstop for the "Ch2 geo class 10" class of bug.
    //
    // ✅ CHANGED: now also passes recentContext, and event/incident-shaped
    // questions ("what happened", "what failed"...) are excluded entirely —
    // see isPureFactualQuery() / EVENT_INCIDENT_WORDS above. This fixes the
    // bug where a follow-up like "What happened with Razorpay on 10th July?"
    // (after an earlier "our Razorpay webhook failed...") was wrongly
    // classified as pure-factual, causing the model to ignore the user's own
    // saved memory in favor of unrelated public/training knowledge.
    plan.is_pure_factual = isPureFactualQuery(userMessage, recentContext);
    if (plan.is_pure_factual && plan.needs_memory) {
      plan.needs_memory = false;
      plan.memory_type = [];
      plan.memory_query = '';
      plan.execution_steps = plan.execution_steps?.filter(s => s !== 'retrieve_memory');
      console.log('Memory retrieval overridden -- pure factual query detected (no personal reference)');
    }

    console.log(`Plan â†’ Intent: ${plan.intent}/${plan.sub_intent} | Topic: ${plan.topic} | Complexity: ${plan.complexity} | Confidence: ${plan.confidence} | Lang: ${plan.language} | Search: ${plan.needs_search}`);
    console.log(`Steps: ${plan.execution_steps?.join(' â†’ ')}`);

    return plan;

  } catch (err) {
    console.error('Planner error:', err.message);
    return getDefaultPlan(userMessage);
  }
}

function getDefaultPlan(message) {
  const lower = message.toLowerCase();

  let intent = 'general';
  if (['code', 'function', 'error', 'bug', 'fix'].some(w => lower.includes(w))) intent = 'coding';
  else if (['explain', 'what is', 'how does', 'kya hai'].some(w => lower.includes(w))) intent = 'learning';
  else if (['my', 'mera', 'project', 'mcis'].some(w => lower.includes(w))) intent = 'project';
  else if (['stressed', 'sad', 'happy', 'feel', 'pareshan'].some(w => lower.includes(w))) intent = 'emotional';

  const needsSearch = shouldSearch(message);

  return {
    intent,
    sub_intent: 'default',
    topic: 'unknown',
    topic_domain: 'general',
    user_goal: 'get_answer',
    emotional_tone: 'neutral',
    needs_memory: lower.includes('my') || lower.includes('mera') || lower.includes('our'),
    memory_type: ['past_chats'],
    memory_query: message.slice(0, 100),
    needs_search: needsSearch,
    search_query: needsSearch ? message : '',
    needs_files: false,
    needs_reasoning: false,
    needs_step_by_step: false,
    needs_code: intent === 'coding',
    needs_examples: false,
    response_format: 'mixed',
    response_length: 'medium',
    complexity: 'simple',
    language: 'english',
    confidence: 0.5,
    fallback_intent: 'general',
    execution_steps: needsSearch
      ? ['search_web', 'build_context', 'generate_answer']
      : ['build_context', 'generate_answer']
  };
}

module.exports = { planQuery, isPureFactualQuery, shouldSearch };