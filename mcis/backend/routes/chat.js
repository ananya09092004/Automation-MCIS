const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { askAI, askAIStream } = require('../services/ai');
const { saveMemory, searchMemory } = require('../services/memory');
const { saveChat, updateChatTitle, deleteChat, getUserChats, saveConversation, getHistory } = require('../services/database');
const { webSearch, needsSearch } = require('../services/search');
const { getCache, setCache } = require('../services/cache');
const { smartSaveMemory, smartSearchMemory, isFullRecallQuery, getFullMemoryDump } = require('../services/memoryManager');
const { getCachedEventResult, cacheEventResult } = require('../services/performanceOptimizer');
const checkDailyLimit = require('../middleware/dailyLimit');
const { getUserProfile, extractAndUpdateProfile } = require('../services/userProfile');
const { safeJsonParse } = require('../services/jsonExtractor');
const { getUserIntelligence, updateUserIntelligence, buildIntelligencePrompt } = require('../services/intelligenceManager');
const { compressHistory } = require('../services/contextManager');
const { generateChatTitle } = require('../services/titleGenerator');
const { generateChatSummary, generateWelcomeMessage } = require('../services/summaryManager');
const { planQuery } = require('../services/plannerService');
const { buildSystemPrompt } = require('../services/promptBuilder');
const { searchPdfChunks } = require('../services/pdfVectorStore');
const { getPreferences, detectAndSavePreferences } = require('../services/preferencesService');
const { getAdaptiveProfileContext } = require('../services/adaptiveProfileService');
const { sendProactiveNotification } = require('../services/proactiveService');
const { addMilestone } = require('../services/lifeTimelineService');
const { verifySyntax } = require('../services/syntaxVerificationService');
const { analyzeComplexity, generateInterviewExplanation } = require('../services/complexityAnalysisService');
const { beautifyCode } = require('../services/codeBeautifierService');
const { detectAlgorithm } = require('../services/algorithmDetectionService');
const { detectEvents, createEvent, processEvents } = require('../services/eventService');
const { extractAndSaveOperatingContext } = require('../services/autonomousContextEngine');
const { getProfileContext } = require('../services/userDeepProfileService');
const { predictUserBehavior: predictBehaviorFromProfile } = require('../services/behaviorAnalyzerService');
const { generateTimelineNarrative } = require('../services/lifeTimelineService');
const { getUserDigitalTwin, getTwinSummary } = require('../services/digitalTwinService');
const { predictUserBehavior: predictBehaviorFromTwin } = require('../services/behaviorPredictionService');
const { getUserKnowledgeGraph, findKnowledgeGaps } = require('../services/knowledgeGraphService');
// ✅ NEW: GitHub repo reader — lets MCIS read a public/private repo the user
// pastes a link to, the same way pdfVectorStore injects PDF content.
const { buildRepoContext } = require('../services/githubRepoReader');
const Groq = require('groq-sdk');
const logger = require('../services/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests. Please wait a minute.' },
  validate: false
});

router.use(limiter);

// Twin/graph/gaps/timeline/behavior-prediction don't change message-to-message,
// but Wave 1 was recomputing all of them on EVERY chat request — since
// Promise.allSettled waits for the slowest call, these heavy ones were the
// real bottleneck before the first streamed token. Cache them per-user with a
// short TTL instead of recomputing every message.
async function getCachedOrFresh(userId, key, fetchFn, ttl = 600000) { // default 10 min
  const cached = getCachedEventResult(userId, key);
  if (cached !== null && cached !== undefined) return cached;
  const fresh = await fetchFn();
  cacheEventResult(userId, key, fresh, ttl);
  return fresh;
}

// Get all chats
router.get('/chats/:userId', async (req, res) => {
  try {
    const chats = await getUserChats(req.params.userId);
    res.json({ success: true, chats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create new chat — welcome message ke saath
router.post('/chats', async (req, res) => {
  try {
    const { chatId, userId, title } = req.body;
    await saveChat(chatId, userId, title);

    logger.info('=== WELCOME START === userId:', userId, 'chatId:', chatId);
    const welcomeMessage = await generateWelcomeMessage(userId, chatId);
    logger.info('=== WELCOME RESULT ===', welcomeMessage?.slice(0, 100));

    res.json({ success: true, welcomeMessage });
  } catch (err) {
    logger.error(`Welcome message error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rename chat
router.patch('/chats/:chatId/rename', async (req, res) => {
  try {
    const { title } = req.body;
    await updateChatTitle(req.params.chatId, title);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete chat
router.delete('/chats/:chatId', async (req, res) => {
  try {
    await deleteChat(req.params.chatId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get messages
router.get('/messages/:userId/:chatId', async (req, res) => {
  try {
    const history = await getHistory(req.params.userId, req.params.chatId);
    res.json({ success: true, messages: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Search across all conversations
router.get('/search/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { q } = req.query;

    if (!q || !userId) {
      return res.json({ success: true, results: [] });
    }

    const { data, error } = await supabase
      .from('conversations')
      .select('id, message, response, chat_id, created_at')
      .eq('user_id', userId)
      .or(`message.ilike.%${q}%,response.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const chatIds = [...new Set(data.map(r => r.chat_id))];
    const { data: chatsData } = await supabase
      .from('chats')
      .select('id, title')
      .in('id', chatIds);

    const chatTitleMap = {};
    chatsData?.forEach(c => { chatTitleMap[c.id] = c.title; });

    const results = data.map(r => ({
      ...r,
      chat_title: chatTitleMap[r.chat_id] || 'Untitled Chat'
    }));

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Message edit
router.post('/edit', async (req, res) => {
  try {
    const { userId, chatId, messageId, newMessage } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    await supabase
      .from('conversations')
      .update({ message: newMessage })
      .eq('id', messageId);

    const plan = await planQuery(newMessage);

    let memoryContext = '';
    if (plan.needs_memory) {
      const memoryQuery = plan.memory_query || `${newMessage} ${plan.topic}`;
      memoryContext = await smartSearchMemory(userId, memoryQuery, { isPureFactual: plan.is_pure_factual });
    }

    // ✅ NEW: repo context for edited messages too, in case the edit itself
    // pastes/changes a GitHub URL. Cheap no-op (returns '' immediately) when
    // there's no GitHub URL in the message.
    let repoContext = '';
    try {
      repoContext = await buildRepoContext(newMessage, userId);
      if (repoContext) logger.info('GitHub repo context loaded ✅ (edit route)');
    } catch (e) {
      logger.error(`Repo context error (edit route): ${e.message}`);
    }

    const profile = await getUserProfile(userId);
    const adaptiveContext = await getAdaptiveProfileContext(userId, newMessage);
    const profileContext = [
      profile ? `Name: ${profile.name || 'unknown'}, City: ${profile.city || 'unknown'}` : '',
      adaptiveContext,
    ].filter(Boolean).join('\n');

    const history = await getHistory(userId, chatId);
    const compressedHistory = compressHistory(history, 8);

    const systemPrompt = buildSystemPrompt(
      plan,
      memoryContext + (repoContext ? `\n\n=== GITHUB REPOSITORY ===\n${repoContext}` : ''),
      '',
      profileContext
    );
    const stream = await askAIStream(newMessage, systemPrompt, compressedHistory, '');
    let fullResponse = '';

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

    await supabase
      .from('conversations')
      .update({ response: fullResponse })
      .eq('id', messageId);

    await smartSaveMemory(userId, newMessage, fullResponse);
    await extractAndSaveOperatingContext(userId, newMessage, fullResponse, chatId);

  } catch (err) {
    logger.error(`Edit error: ${err.message}`);
    res.end();
  }
});

// Stream route — main chat
router.post('/stream', checkDailyLimit, async (req, res) => {
  try {
    const { userId, message, chatId } = req.body;
    if (!userId || !message || !chatId) {
      return res.status(400).json({ success: false, error: 'userId, message and chatId required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Fire the planner (an LLM call) IMMEDIATELY, in parallel with Wave 1,
    // instead of waiting for Wave 1 to finish first. It only needs a small
    // slice of recent history, not the full Wave 1 result set, so a cheap
    // separate 2-turn history fetch unblocks it right away. This alone
    // removes one full sequential LLM round-trip from the critical path.
    const planPromise = getHistory(userId, chatId, 2)
      .catch(() => [])
      .then(quickHistory => planQuery(message, quickHistory, null));

    // ===== WAVE 1 — everything that does NOT depend on the query plan
    // runs concurrently instead of one-by-one. Twin/graph/gaps/timeline/
    // behavior-prediction are also now cached per-user (10-30 min TTL, see
    // getCachedOrFresh above) since they rarely change message-to-message —
    // recomputing them every single request was the biggest remaining
    // latency source in this wave.
    //
    // ✅ NEW: GitHub repo context also runs here, in parallel with everything
    // else — same reasoning as PDF search: it's independent of the query
    // plan, and buildRepoContext() itself returns '' immediately (no network
    // calls) when the message has no GitHub URL, so this adds ~0 overhead
    // for the vast majority of messages that don't mention a repo. =====
    const [
      rawHistoryResult,
      profileResult,
      adaptiveContextResult,
      pdfContextResult,
      repoContextResult,
      userPrefsResult,
      intelligenceResult,
      profileContextDeepResult,
      behaviorPredictionResult,
      timelineNarrativeResult,
      twinResult,
      graphResult,
      gapsResult,
    ] = await Promise.allSettled([
      getHistory(userId, chatId),
      getUserProfile(userId),
      getAdaptiveProfileContext(userId, message),
      searchPdfChunks(userId, message),
      buildRepoContext(message, userId),
      getPreferences(userId),
      getUserIntelligence(userId),
      getProfileContext(userId),
      getCachedOrFresh(userId, 'behavior', () => predictBehaviorFromProfile(userId)),
      getCachedOrFresh(userId, 'timeline', () => generateTimelineNarrative(userId), 1800000),
      getCachedOrFresh(userId, 'twin', () => getUserDigitalTwin(userId)),
      getCachedOrFresh(userId, 'graph', () => getUserKnowledgeGraph(userId)),
      getCachedOrFresh(userId, 'gaps', () => findKnowledgeGaps(userId)),
    ]);

    const settled = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);
    const logFailed = (label, r) => { if (r.status === 'rejected') logger.error(`${label} error: ${r.reason?.message || r.reason}`); };
    [
      ['History', rawHistoryResult], ['Profile', profileResult], ['AdaptiveContext', adaptiveContextResult],
      ['PDF search', pdfContextResult], ['Repo context', repoContextResult], ['Preferences', userPrefsResult],
      ['Intelligence', intelligenceResult], ['Deep profile', profileContextDeepResult],
      ['Behavior prediction', behaviorPredictionResult], ['Timeline', timelineNarrativeResult],
      ['Digital twin', twinResult], ['Knowledge graph', graphResult], ['Knowledge gaps', gapsResult],
    ].forEach(([label, r]) => logFailed(label, r));

    const rawHistory = settled(rawHistoryResult, []);
    const history = compressHistory(rawHistory, 10);
    const profile = settled(profileResult, null);
    const adaptiveContext = settled(adaptiveContextResult, '');
    const profileContext = [
      profile ? `Name: ${profile.name || 'unknown'}, City: ${profile.city || 'unknown'}, Profession: ${profile.profession || 'unknown'}` : '',
      adaptiveContext,
    ].filter(Boolean).join('\n');

    let pdfContext = settled(pdfContextResult, '');
    if (pdfContext) logger.info('PDF chunks found ✅');

    // ✅ NEW: GitHub repo context result from Wave 1
    const repoContext = settled(repoContextResult, '');
    if (repoContext) logger.info('GitHub repo context loaded ✅');

    const userPrefs = settled(userPrefsResult, {});
    let preferencesContext = '';
    if (Object.keys(userPrefs).length > 0) {
      preferencesContext = Object.entries(userPrefs).map(([key, value]) => `- ${key}: ${value}`).join('\n');
      logger.info(`User preferences: ${preferencesContext}`);
    }

    const intelligence = settled(intelligenceResult, null);
    const intelligenceContext = buildIntelligencePrompt(intelligence);

    const profileContext_deep = settled(profileContextDeepResult, '');
    const behaviorPrediction = settled(behaviorPredictionResult, null);
    let personalizationContext = '';
    if (profileContext_deep) {
      personalizationContext = profileContext_deep;
      if (behaviorPrediction?.best_hours) {
        personalizationContext += `\nOptimal work hours: ${behaviorPrediction.best_hours.join(', ')}:00`;
      }
    }

    const timelineNarrative = settled(timelineNarrativeResult, '');
    const timelineContext = timelineNarrative ? `\nYOUR GROWTH:\n${timelineNarrative.substring(0, 300)}...` : '';

    const twin = settled(twinResult, null);
    const graph = settled(graphResult, { nodes: [] });
    const gaps = settled(gapsResult, []);

    // ===== WAVE 2 — the query planner was already fired above (in parallel
    // with Wave 1) via planPromise, so we just await it here instead of
    // calling planQuery again. The digital-twin follow-up only needs Wave 1
    // data, so it still runs concurrently alongside awaiting the planner. =====
    const [planResult, twinFollowupResult] = await Promise.allSettled([
      planPromise,
      (async () => {
        if (!twin) return '';
        let ctx = await getTwinSummary(userId);
        if (message.length > 10) {
          const prediction = await predictBehaviorFromTwin(userId, twin, message);
          if (prediction.success && prediction.prediction.procrastination_probability > 0.6) {
            ctx += `\n⚠️ TWIN ALERT: User might procrastinate. ${prediction.prediction.recommended_intervention}`;
          }
        }
        return ctx;
      })(),
    ]);

    if (planResult.status === 'rejected') {
      logger.error(`Planner error: ${planResult.reason?.message || planResult.reason}`);
    }
    if (twinFollowupResult.status === 'rejected') {
      logger.error(`Twin context error: ${twinFollowupResult.reason?.message || twinFollowupResult.reason}`);
    }
    const plan = planResult.status === 'fulfilled' ? planResult.value : {};
    const twinContext = settled(twinFollowupResult, '');

    logger.info(`Plan → Intent: ${plan.intent}/${plan.sub_intent} | Topic: ${plan.topic} | Complexity: ${plan.complexity} | Confidence: ${plan.confidence} | Lang: ${plan.language}`);
    logger.info(`Steps: ${plan.execution_steps?.join(' → ')}`);

    // Memory delete intent handle karo — sirf explicit delete words pe
    const EXPLICIT_DELETE_WORDS = [
      'forget', 'delete', 'remove', 'bhool ja', 'hatao', 'mita do',
      'mita de', 'bhul ja', 'hata do', 'delete karo', 'remove karo'
    ];
    const isExplicitDelete = EXPLICIT_DELETE_WORDS.some(w => 
      message.toLowerCase().includes(w)
    );

    if (plan.intent === 'memory_delete' && isExplicitDelete) {
      try {
        const nlRes = await fetch(`${process.env.BACKEND_URL || 'https://mcis-backend.onrender.com'}/api/memory/nl-delete/${userId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: message })
        });
        const nlData = await nlRes.json();
        const confirmMsg = nlData.deleted > 0
          ? `Done — removed ${nlData.deleted} memory.`
          : `Couldn't find a matching memory to delete.`;
        res.write(`data: ${JSON.stringify({ text: confirmMsg })}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify({ text: "Couldn't process that deletion." })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // ===== WAVE 3 — memory + web search both depend on the plan, but not
    // on each other, so they run concurrently instead of sequentially. =====
    // "sab batao / what do you know about me" type queries bypass the
    // normal top-K/threshold retrieval and get a full category-grouped dump
    // instead — normal chat speed is untouched.
    const fullRecall = isFullRecallQuery(message);
    const needsMemory = fullRecall || plan.execution_steps?.includes('retrieve_memory') || plan.needs_memory;
    const needsWebSearch = plan.execution_steps?.includes('search_web') || plan.needs_search || needsSearch(message);

    if (needsWebSearch) {
      res.write(`data: ${JSON.stringify({ text: 'Searching the web...\n\n' })}\n\n`);
    }

    const [memoryContextResult, searchContextResult] = await Promise.allSettled([
      fullRecall
        ? getFullMemoryDump(userId)
        : needsMemory
        ? smartSearchMemory(
            userId,
            plan.memory_query || `${message} ${plan.memory_type?.join(' ') || ''} ${plan.topic || ''}`.trim(),
            { isPureFactual: plan.is_pure_factual }
          )
        : Promise.resolve(''),
      needsWebSearch
        ? webSearch(plan.search_query || message)
        : Promise.resolve(''),
    ]);

    if (memoryContextResult.status === 'rejected') logger.error(`Memory search error: ${memoryContextResult.reason?.message || memoryContextResult.reason}`);
    if (searchContextResult.status === 'rejected') logger.error(`Web search error: ${searchContextResult.reason?.message || searchContextResult.reason}`);

    const memoryContext = settled(memoryContextResult, '');
    const searchContext = settled(searchContextResult, '');
    if (fullRecall) logger.info('Full recall triggered — bypassed top-K memory limit');
    else if (needsMemory) logger.info(`Memory retrieved with ranking: ${memoryContext ? 'YES' : 'NO'}`);
    if (needsWebSearch) logger.info('Web search triggered');

    // Knowledge graph context (built from Wave 1 results)
    let graphContext = '';
    if (graph.nodes && graph.nodes.length > 0) {
      const skills = graph.nodes.filter(n => n.node_type === 'skill').map(n => n.name).join(', ');
      const projects = graph.nodes.filter(n => n.node_type === 'project').map(n => n.name).join(', ');
      const goals = graph.nodes.filter(n => n.node_type === 'goal').map(n => n.name).join(', ');
      graphContext = `KNOWLEDGE CONTEXT:
Skills: ${skills || 'None'}
Projects: ${projects || 'None'}
Goals: ${goals || 'None'}`;
      if (gaps && gaps.length > 0) {
        graphContext += `\nLearning gaps to address: ${gaps.slice(0, 2).map(g => g.recommendation).join(', ')}`;
      }
    }

    // STEP 6 — Prompt Builder with personalization
    // ✅ NEW: repoContext (from Wave 1) is appended the same way pdfContext
    // is — as its own labeled block inside the memory-context argument, so
    // the model sees "=== GITHUB REPOSITORY ===" clearly separated from
    // memory and PDF content.
    const systemPrompt = buildSystemPrompt(
      plan,
      memoryContext +
        (pdfContext ? `\n\n=== RELEVANT PDF CONTENT ===\n${pdfContext}` : '') +
        (repoContext ? `\n\n=== GITHUB REPOSITORY ===\n${repoContext}` : ''),
      searchContext,
      (profileContext || '') + 
        (personalizationContext ? `\n\n${personalizationContext}` : '') +
        (timelineContext ? `\n${timelineContext}` : '') +
        (twinContext ? `\n\n${twinContext}` : '') +
        (intelligenceContext ? `\nCommunication style: ${intelligenceContext}` : '') +
        (graphContext ? `\n\n${graphContext}` : ''),
      preferencesContext
    );

    logger.info(`Context → Memory: ${memoryContext ? 'YES' : 'NO'} | PDF: ${pdfContext ? 'YES' : 'NO'} | Repo: ${repoContext ? 'YES' : 'NO'} | Search: ${searchContext ? 'YES' : 'NO'} | Intent: ${plan.intent}/${plan.sub_intent}`);

    // STEP 7 — Generator. `plan` is passed through so complex/reasoning-heavy
    // queries (plan.complexity === 'high', code_generation/debugging/etc.)
    // route to the deep-accuracy model tier instead of the default fast one.
    const stream = await askAIStream(message, systemPrompt, history, '', 4096, plan);
    let fullResponse = '';

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    // Title + smart suggestions are two independent LLM calls — run them
    // concurrently instead of one after another so [DONE] arrives sooner.
    const [titleResult, suggestionsResult] = await Promise.allSettled([
      rawHistory.length === 0 ? generateChatTitle(message, fullResponse) : Promise.resolve(null),
      (async () => {
        const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const suggestRes = await groqClient.chat.completions.create({
          messages: [
            {
              role: 'system',
              content: 'Generate exactly 3 short follow-up questions (max 6 words each) based on the conversation. Return ONLY a valid JSON array of 3 strings. No explanation, no markdown.'
            },
            {
              role: 'user',
              content: `User asked: ${message}\nAI replied: ${fullResponse.slice(0, 300)}\n\nGenerate 3 follow-up questions:`
            }
          ],
          model: 'qwen/qwen3.6-27b',
          // FIX (root cause, not just a bigger budget): qwen3.6-27b is a
          // reasoning model that emits an internal <think> block before the
          // real answer. Raising max_tokens alone is a guessing game -- the
          // <think> block length varies per request. services/ai.js already
          // solves this correctly for the main chat calls via
          // getExtraParamsForModel(), which passes reasoning_effort:'none' for
          // this exact model to suppress the <think> block entirely. Reusing
          // that here so this call never produces a <think> block at all.
          reasoning_effort: 'none',
          max_tokens: 200,
          temperature: 0.7
        });
        const sugText = suggestRes.choices[0].message.content.trim();
        return safeJsonParse(sugText);
      })(),
    ]);

    if (titleResult.status === 'fulfilled' && titleResult.value) {
      const title = titleResult.value;
      await updateChatTitle(chatId, title);
      res.write(`data: ${JSON.stringify({ titleUpdate: title })}\n\n`);
    } else if (titleResult.status === 'rejected') {
      logger.error(`Title generation error: ${titleResult.reason?.message || titleResult.reason}`);
    }

    if (suggestionsResult.status === 'fulfilled' && Array.isArray(suggestionsResult.value) && suggestionsResult.value.length > 0) {
      res.write(`data: ${JSON.stringify({ suggestions: suggestionsResult.value })}\n\n`);
    } else if (suggestionsResult.status === 'rejected') {
      logger.info(`Suggestions skipped: ${suggestionsResult.reason?.message || suggestionsResult.reason}`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
    // ===== AUTO-DETECT MILESTONES =====
    try {
      const { detectMilestones } = require('../services/lifeTimelineService');
      
      // Check if message contains achievement language
      const achievementKeywords = [
        'completed', 'finished', 'mastered', 'learned', 'achieved',
        'solved', 'built', 'deployed', 'launched', 'succeeded',
        'finally', 'done', 'accomplished', 'nailed', 'crushed'
      ];

      const hasAchievement = achievementKeywords.some(kw => 
        message.toLowerCase().includes(kw)
      );

      if (hasAchievement) {
        const { detectMilestones } = require('../services/lifeTimelineService');
        
        // Use Groq to detect milestone
        const milePrompt = `Extract milestone from: "${message}"
Return JSON: {"milestone": "...", "category": "...", "impact": 1-5}
Or empty {} if none.`;

        const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const mileCompletion = await groqClient.chat.completions.create({
          model: 'qwen/qwen3.6-27b',
          messages: [{ role: 'user', content: milePrompt }],
          max_tokens: 200,
          temperature: 0.7
        });

        const mileText = mileCompletion.choices[0].message.content;
        
        try {
          const detected = safeJsonParse(mileText);
          if (detected.milestone) {
            await addMilestone(userId, {
              title: detected.milestone,
              category: detected.category || 'achievement',
              impact_level: detected.impact || 3,
              confidence_change: 0.15
            });
            logger.info(`Milestone auto-detected: ${detected.milestone}`);
          }
        } catch {}
      }
    } catch (mileErr) {
      logger.error(`Milestone detection error: ${mileErr.message}`);
    }
    // ===================================
    // ===== EVENT DETECTION & PROCESSING =====
    try {
      const messageCount = rawHistory.length;
      const { processEventTriggers } = require('../services/eventService');
      const { generateRecommendation, saveRecommendation } = require('../services/recommendationEngine');
      const { logEventReplay } = require('../services/eventReplayService');
      const { getCachedEventResult, cacheEventResult } = require('../services/performanceOptimizer');
      
      // Detect events
      const detectedEvents = detectEvents(message, messageCount);
      
      // Process each event
      for (const evt of detectedEvents) {
        // Check cache
        const cached = getCachedEventResult(userId, evt.type);
        if (cached) {
          logger.info(`Event from cache: ${evt.type}`);
          continue;
        }

        // Create event
        const { data: eventData } = await supabase
          .from('events')
          .insert([{
            user_id: userId,
            event_type: evt.type,
            data: evt.data,
            created_at: new Date().toISOString()
          }])
          .select();

        // Execute triggers
        await processEventTriggers(userId, [evt]);

        // Generate recommendations
        const recommendation = await generateRecommendation(evt, memoryContext);
        if (recommendation && eventData) {
          await saveRecommendation(userId, evt.type, recommendation);
          await logEventReplay(userId, eventData[0].id, evt.data);
        }

        // Cache result
        cacheEventResult(userId, evt.type, evt);

        logger.info(`Event processed: ${evt.type}`);
      }
    } catch (evtErr) {
      logger.error(`Event processing error: ${evtErr.message}`);
    }
    // =========================================
    // ===== GOAL EXECUTION ENGINE =====
    try {
      if (plan.intent === 'goal_creation' || message.toLowerCase().includes('goal')) {
        const { createGoalWithBreakdown } = require('../services/goalBreakdownService');
        const { generateDailyPlan, saveDailyPlan } = require('../services/dailyPlanService');
        
        // Extract goal from message
        const goalMatch = message.match(/goal[:\s]+([^.!?]+)/i);
        if (goalMatch) {
          const goalTitle = goalMatch[1].trim();
          
          // Create goal with breakdown
          const goalResult = await createGoalWithBreakdown(userId, goalTitle, message, new Date(Date.now() + 180*24*60*60*1000));
          
          if (goalResult.success) {
            logger.info(`Goal created: ${goalTitle}`);
          }
        }
      }
    } catch (goalErr) {
      logger.error(`Goal execution error: ${goalErr.message}`);
    }

    // ===== CODING INTELLIGENCE INTEGRATION =====
    try {
      if (message.toLowerCase().includes('code') || message.toLowerCase().includes('problem')) {
        const { getCodingProfile } = require('../services/codingProfileService');
        
        // Get user's coding profile for personalization
        const codingProfile = await getCodingProfile(userId);
        
        // Detect if this is a coding problem
        if (message.includes('find') || message.includes('implement') || message.includes('solve')) {
          const detection = await detectAlgorithm(userId, message);
          if (detection.success) {
            // Will use detection.detection.primary_algorithm for response customization
            logger.info(`Algorithm detected: ${detection.detection.primary_algorithm}`);
          }
        }
      }
    } catch (codingErr) {
      logger.error(`Coding intelligence error: ${codingErr.message}`);
    }
    // =========================================

    // ===== COMPLETE CODE QUALITY PIPELINE (WITH USER PREFERENCE) =====
    try {
      if (plan.intent === 'code_generation' || message.toLowerCase().includes('code')) {
        const { runCompleteCodeQualityPipeline } = require('../services/codeQualityPipelineService');
        const { detectCodePreference, getUserCodePreferences } = require('../services/userCodePreferencesService');
        const { formatCodeOutput } = require('../services/codeOutputFormatterService');
        
        // Check if response contains code
        const codeBlockMatch = fullResponse.match(/```[\w]*\n([\s\S]*?)```/);
        
        if (codeBlockMatch) {
          const code = codeBlockMatch[1];
          const language = codeBlockMatch[0].match(/```(\w+)/)?.[1] || 'python';
          
          logger.info(`🚀 Code Pipeline Starting | Language: ${language}`);
          
          // DETECT USER PREFERENCE FROM MESSAGE
          const messagePreference = detectCodePreference(message);
          const savedPreference = await getUserCodePreferences(userId);
          const userPreference = messagePreference !== 'balanced' ? messagePreference : savedPreference.output_format;
          
          logger.info(`User Preference: ${userPreference}`);
          
          // ===== RUN COMPLETE PIPELINE =====
          logger.info('Step 1️⃣: Running Complete Code Quality Pipeline...');
          const pipelineResult = await runCompleteCodeQualityPipeline(
            userId,
            code,
            language,
            null,
            message
          );

          if (pipelineResult.success) {
            // Show what was done (all functions used!)
            logger.info(`✅ SYNTAX VERIFICATION: ${pipelineResult.steps[0]?.status || 'PASS'} (verifySyntax)`);
            logger.info(`✅ CODE BEAUTIFICATION: ${pipelineResult.steps[1]?.status || 'PASS'} (beautifyCode)`);
            logger.info(`✅ ALGORITHM DETECTION: ${pipelineResult.steps[2]?.algorithm || 'Detected'}`);
            logger.info(`✅ ADVERSARIAL TESTING: ${pipelineResult.tests_passed}/${pipelineResult.tests_total} passed`);
            logger.info(`✅ COMPLEXITY ANALYSIS: Time=${pipelineResult.complexity?.time || 'Analyzed'}, Space=${pipelineResult.complexity?.space || 'Analyzed'} (analyzeComplexity)`);
            logger.info(`✅ AUTO-REPAIR: ${pipelineResult.repairs_made} issues fixed`);
            logger.info(`✅ INTERVIEW EXPLANATION: Generated (generateInterviewExplanation)`);
            
            // Format output based on USER PREFERENCE (NOT forced explanation)
            logger.info(`Step 2️⃣: Formatting output (Preference: ${userPreference})...`);
            const formattedOutput = await formatCodeOutput(
              pipelineResult,
              userPreference,
              language
            );

            // Replace code block with formatted output
            fullResponse = fullResponse.replace(
              codeBlockMatch[0],
              formattedOutput.output
            );

            // Log comprehensive summary
            logger.info(`
╔══════════════════════════════════════╗
║     CODE QUALITY PIPELINE SUMMARY      ║
╚══════════════════════════════════════╝
✅ verifySyntax: ${pipelineResult.steps[0]?.status || 'PASS'}
✅ beautifyCode: ${pipelineResult.steps[1]?.status || 'PASS'}
✅ analyzeComplexity: Time=${pipelineResult.complexity?.time}, Space=${pipelineResult.complexity?.space}
✅ generateInterviewExplanation: Generated
✅ Adversarial Tests: ${pipelineResult.tests_passed}/${pipelineResult.tests_total} passed
✅ Auto-Repairs: ${pipelineResult.repairs_made} applied
✅ Output Format: ${formattedOutput.message}
✅ User Preference: ${userPreference}
            `);
          } else {
            logger.error(`❌ Pipeline failed: ${pipelineResult.error}`);
          }
        }
      }
    } catch (pipelineErr) {
      logger.error(`Code quality pipeline error: ${pipelineErr.message}`);
    }
    // ==========================================

    // STEP 7.5 — Proactive notification for future
    try {
      if (plan.intent === 'learning' || plan.intent === 'project' || plan.intent === 'coding') {
        const topicStr = plan.topic || 'learning';
        const suggestion = `You were working on ${topicStr}. Keep up the momentum!`;
        await sendProactiveNotification(userId, suggestion, 'suggestion');
        logger.info(`Proactive notification sent for ${topicStr}`);
      }
    } catch (err) {
      logger.error(`Proactive notification error: ${err.message}`);
    }

    // Save everything
    await smartSaveMemory(userId, message, fullResponse);
    await saveConversation(userId, message, fullResponse, chatId);
    await extractAndSaveOperatingContext(userId, message, fullResponse, chatId);
    await extractAndUpdateProfile(userId, message, fullResponse);
    await updateUserIntelligence(userId, message);

    const updatedHistory = await getHistory(userId, chatId);
    try {
      await generateChatSummary(userId, chatId, updatedHistory);
      logger.info('Chat summary updated ✅');
    } catch (summaryErr) {
      logger.error(`Summary error: ${summaryErr.message}`);
    }

  } catch (error) {
    logger.error(`Stream error: ${error.message}`);
    res.end();
  }
});

// Welcome message for existing chat
router.get('/welcome/:userId/:chatId', async (req, res) => {
  try {
    const { userId, chatId } = req.params;
    const welcomeMessage = await generateWelcomeMessage(userId, chatId);
    res.json({ success: true, welcomeMessage });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;