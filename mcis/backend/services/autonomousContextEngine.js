const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const logger = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const OPERATING_CATEGORIES = {
  decision: 'decision',
  risk: 'risk',
  next_action: 'next_action',
  future_path: 'future_path',
  insight: 'insight',
};

function cleanText(value = '', max = 220) {
  let text = String(value).replace(/\s+/g, ' ').trim();
  // Strip stray leading punctuation/connectors that regex captures sometimes
  // leave behind (e.g. a match starting on ", as ..." or "- and ...").
  text = text.replace(/^[,:;\-–—\s]+/, '').replace(/^(and|as|is|are|to|the|a|an)\s+/i, '');
  if (text) text = text[0].toUpperCase() + text.slice(1);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.type}:${item.title}:${item.detail}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Cross-session dedup: compares a candidate detail against previously
// saved items of the same type using word-overlap (Jaccard) similarity, so
// the same idea phrased slightly differently in a later chat doesn't create
// another near-identical card in the Life OS panels. ─────────────────────
function wordSet(text = '') {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach(w => { if (setB.has(w)) intersection += 1; });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DEDUP_SIMILARITY_THRESHOLD = 0.55;

async function filterOutDuplicates(userId, items) {
  if (!items.length) return items;

  const types = [...new Set(items.map(item => item.type))];
  const categories = types.flatMap(type => [`${type}`, `pending_${type}`]);

  const { data: existing, error } = await supabase
    .from('user_memories')
    .select('category, content')
    .eq('user_id', userId)
    .in('category', categories)
    .order('created_at', { ascending: false })
    .limit(60);

  if (error || !existing?.length) return items;

  const existingDetails = existing.map(row => stripOperatingPrefixLocal(row.content));

  return items.filter(item => {
    const isDup = existingDetails.some(
      existingDetail => jaccardSimilarity(item.detail, existingDetail) >= DEDUP_SIMILARITY_THRESHOLD
    );
    return !isDup;
  });
}

function stripOperatingPrefixLocal(content = '') {
  return String(content)
    .replace(/^\[(decision|risk|next_action|future_path|insight)\]\s*/i, '')
    .replace(/\s*\|\s*urgency:\s*\w+/i, '')
    .replace(/\s*\|\s*confidence:\s*\d+(\.\d+)?/i, '')
    .replace(/\s*\|\s*chat:\s*[\w-]+/i, '')
    .trim();
}

function classifyUrgency(text = '') {
  const lower = text.toLowerCase();
  if (/(urgent|asap|today|kal|deadline|overdue|critical|stuck|blocked)/.test(lower)) return 'high';
  if (/(soon|week|risk|problem|issue|pending|important)/.test(lower)) return 'medium';
  return 'normal';
}

function heuristicExtract(userMessage = '', aiResponse = '') {
  const text = `${userMessage}\n${aiResponse}`;
  const lower = text.toLowerCase();
  const items = [];

  const decisionSignals = [
    'decided', 'decision', 'choose', 'chose', 'focus on', 'instead of',
    'final', 'strategy', 'positioning', 'direction', 'not assistant',
    'assistant nahi', 'life os', 'operating system',
  ];

  if (decisionSignals.some(signal => lower.includes(signal))) {
    items.push({
      type: OPERATING_CATEGORIES.decision,
      title: 'Direction decision',
      detail: cleanText(userMessage || aiResponse, 180),
      confidence: 0.72,
      source: 'heuristic',
    });
  }

  const riskSignals = ['risk', 'crowded', 'competition', 'problem', 'issue', 'stuck', 'hard', 'difficult', 'already', 'bhout', 'bahut'];
  if (riskSignals.some(signal => lower.includes(signal))) {
    items.push({
      type: OPERATING_CATEGORIES.risk,
      title: 'Something to watch out for',
      detail: cleanText(userMessage || aiResponse, 180),
      urgency: classifyUrgency(text),
      confidence: 0.68,
      source: 'heuristic',
    });
  }

  // NOTE: \b word boundaries are required here. Without them "task" also
  // matches inside "tasks", "start" inside "restart", etc., and the capture
  // group then grabs whatever text follows the matched substring — which is
  // how a sentence like "Ensure background tasks are idempotent..." turned
  // into a saved item reading "s are idempotent...".
  const actionPatterns = [
    /\b(?:build|add|create|implement|make|ship|launch|banao|banwa|kara|start)\b\s+([^.!?\n]{8,120})/gi,
    /\b(?:next step|next action|todo|task)\b\s*:?\s*([^.!?\n]{8,120})/gi,
  ];

  actionPatterns.forEach(pattern => {
    let match = pattern.exec(text);
    while (match) {
      const detail = cleanText(match[1], 160);
      // Guard against low-quality captures (too short after cleaning, or
      // still starting mid-word due to an unexpected pattern overlap).
      if (detail && detail.length >= 8) {
        items.push({
          type: OPERATING_CATEGORIES.next_action,
          title: 'Suggested next step',
          detail,
          urgency: classifyUrgency(match[0]),
          confidence: 0.66,
          source: 'heuristic',
        });
      }
      match = pattern.exec(text);
    }
  });

  if (/(future|simulate|path|outcome|scenario|prediction|trajectory|level up|upar)/.test(lower)) {
    items.push({
      type: OPERATING_CATEGORIES.future_path,
      title: 'Future path to think about',
      detail: cleanText(userMessage || 'Compare possible future outcomes before choosing execution.', 180),
      confidence: 0.63,
      source: 'heuristic',
    });
  }

  if (/(unique|different|alag|moat|better|claude|gpt|product)/.test(lower)) {
    items.push({
      type: OPERATING_CATEGORIES.insight,
      title: 'What makes MCIS different',
      detail: cleanText('MCIS should compete as a context-first execution system, not as another chat assistant.', 180),
      confidence: 0.7,
      source: 'heuristic',
    });
  }

  return uniqueItems(items).slice(0, 8);
}

async function aiExtract(userMessage = '', aiResponse = '') {
  if (!process.env.GROQ_API_KEY) return [];

  try {
    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'system',
          content: `Extract operating-system items from this conversation for a Life OS dashboard.
Return ONLY valid JSON:
{"items":[{"type":"decision|risk|next_action|future_path|insight","title":"short title","detail":"specific detail","urgency":"high|medium|normal","confidence":0.0}]}

Writing rules (very important):
- Write "title" and "detail" in plain, everyday English that a non-technical person can understand at a glance. This dashboard is read by the product owner, not just an engineer.
- Do NOT use technical jargon, library/framework names, or code-level terms (e.g. "Celery", "idempotent", "async", "HTTP 200") unless the user's own message used that exact term first. Translate the technical point into what it means in plain terms and why it matters, instead of restating the implementation detail.
- Each "detail" must be one complete, grammatically correct sentence or two — never a sentence fragment, and never text that starts mid-word or mid-sentence.
- Keep "detail" under 160 characters where possible. Be concrete, not vague.
- If the conversation only rephrases something already obviously covered (e.g. the same webhook timeout issue discussed again), do not create a near-duplicate item for it — only include it if there is a genuinely new angle or next step.
- Max 6 items, and no two items should express the same underlying point.`,
        },
        {
          role: 'user',
          content: `USER:\n${userMessage.slice(0, 1800)}\n\nASSISTANT:\n${aiResponse.slice(0, 2200)}`,
        },
      ],
      max_tokens: 550,
      temperature: 0.2,
      reasoning_effort: 'none',
    });

    const raw = completion.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(parsed.items)) return [];

    return parsed.items
      .filter(item => OPERATING_CATEGORIES[item.type] || Object.values(OPERATING_CATEGORIES).includes(item.type))
      .map(item => ({
        type: item.type,
        title: cleanText(item.title || item.type, 80),
        detail: cleanText(item.detail || '', 220),
        urgency: ['high', 'medium', 'normal'].includes(item.urgency) ? item.urgency : 'normal',
        confidence: Number(item.confidence || 0.75),
        source: 'ai',
      }))
      .filter(item => item.detail && item.detail.length >= 8)
      .slice(0, 6);
  } catch (err) {
    logger.info(`Autonomous context AI extraction skipped: ${err.message}`);
    return [];
  }
}

function formatMemoryContent(item, chatId) {
  const urgency = item.urgency ? ` | urgency: ${item.urgency}` : '';
  const source = chatId ? ` | chat: ${chatId}` : '';
  return `[${item.type}] ${item.title}: ${item.detail}${urgency} | confidence: ${Number(item.confidence || 0.7).toFixed(2)}${source}`;
}

async function saveOperatingItems(userId, items, chatId = null) {
  if (!items.length) return [];

  const deduped = await filterOutDuplicates(userId, uniqueItems(items));
  if (!deduped.length) return [];

  const rows = deduped.map(item => ({
    user_id: userId,
    category: `pending_${item.type}`,
    content: formatMemoryContent(item, chatId),
    created_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('user_memories')
    .insert(rows)
    .select();

  if (error) throw error;
  return data || [];
}

async function extractAndSaveOperatingContext(userId, userMessage, aiResponse, chatId = null) {
  try {
    if (!userId || !userMessage || userMessage.trim().split(/\s+/).length < 5) {
      return { success: true, saved: [], items: [] };
    }

    const heuristicItems = heuristicExtract(userMessage, aiResponse);
    const aiItems = await aiExtract(userMessage, aiResponse);
    const items = uniqueItems([...aiItems, ...heuristicItems]).slice(0, 10);

    if (!items.length) return { success: true, saved: [], items: [] };

    const saved = await saveOperatingItems(userId, items, chatId);
    logger.info(`Autonomous context saved ${saved.length} operating item(s) for ${userId}`);
    return { success: true, saved, items };
  } catch (err) {
    logger.error(`Autonomous context save error: ${err.message}`);
    return { success: false, error: err.message, saved: [], items: [] };
  }
}

function simulateLite(decision = '', context = {}) {
  const cleanDecision = cleanText(decision, 180) || 'Choose the best next direction';
  const contextText = JSON.stringify(context || {}).toLowerCase();
  const isProduct = /product|mcis|assistant|gpt|claude|startup|feature/.test(`${cleanDecision} ${contextText}`.toLowerCase());

  const paths = isProduct
    ? [
      {
        name: 'Path A: Better chatbot',
        successProbability: 0.42,
        timeToSignalDays: 45,
        riskLevel: 'high',
        upside: 'Fast to explain, easy to demo.',
        downside: 'Crowded market and weak differentiation against major models.',
        nextStep: 'Do not lead with this path; keep chat as the command interface only.',
      },
      {
        name: 'Path B: Personal Life OS',
        successProbability: 0.71,
        timeToSignalDays: 21,
        riskLevel: 'medium',
        upside: 'Strong category shift: memory plus decisions plus execution.',
        downside: 'Needs trust, review controls, and excellent dashboard UX.',
        nextStep: 'Ship approve/reject flow and show decisions, risks, actions, and future paths clearly.',
      },
      {
        name: 'Path C: Coding execution workspace',
        successProbability: 0.64,
        timeToSignalDays: 30,
        riskLevel: 'medium',
        upside: 'Concrete daily value for builders and students.',
        downside: 'Requires reliable code execution, verification, and project continuity.',
        nextStep: 'Connect Life OS actions to build tasks, code quality checks, and GitHub.',
      },
    ]
    : [
      {
        name: 'Path A: Keep current direction',
        successProbability: 0.52,
        timeToSignalDays: 30,
        riskLevel: 'medium',
        upside: 'Lowest disruption and easiest to start.',
        downside: 'May preserve current blockers.',
        nextStep: `Define one measurable signal for: ${cleanDecision}`,
      },
      {
        name: 'Path B: Narrow focus',
        successProbability: 0.68,
        timeToSignalDays: 14,
        riskLevel: 'low',
        upside: 'Clear execution and faster feedback.',
        downside: 'Some ideas must be postponed.',
        nextStep: 'Choose the smallest outcome that proves this direction works.',
      },
      {
        name: 'Path C: Ambitious expansion',
        successProbability: 0.39,
        timeToSignalDays: 60,
        riskLevel: 'high',
        upside: 'Big upside if execution quality is strong.',
        downside: 'More moving parts and higher chance of losing focus.',
        nextStep: 'List dependencies and remove anything that is not essential.',
      },
    ];

  return {
    success: true,
    decision: cleanDecision,
    generatedAt: new Date().toISOString(),
    recommendation: paths.slice().sort((a, b) => b.successProbability - a.successProbability)[0],
    paths,
  };
}

function fallbackAgentPlan(task = '', context = {}) {
  const objective = cleanText(task, 180) || 'Move this Life OS item forward';
  const lower = `${objective} ${JSON.stringify(context || {})}`.toLowerCase();
  const isCoding = /(code|build|bug|feature|github|deploy|project|repo|api|frontend|backend)/.test(lower);
  const isResearch = /(research|compare|market|strategy|competitor|study|learn)/.test(lower);

  const executeTool = isCoding
    ? 'Build Workspace + code verification'
    : isResearch
      ? 'Research agent + decision summary'
      : 'Life OS planner + focused work session';

  const verification = isCoding
    ? 'Run build/tests or inspect generated files, then save pass/fail result.'
    : isResearch
      ? 'Check whether the output answers the decision question with evidence and next step.'
      : 'Confirm the task produced a visible output and update progress.';

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    objective,
    estimatedMinutes: isCoding ? 60 : 35,
    mode: isCoding ? 'build' : isResearch ? 'research' : 'execution',
    tools: [
      'Life OS context',
      executeTool,
      'Memory learning loop',
    ],
    steps: [
      {
        id: 'break-down',
        title: 'Break goal into tasks',
        detail: `Define the smallest useful outcome for: ${objective}`,
        output: 'A concrete task list with one visible deliverable.',
      },
      {
        id: 'pick-today',
        title: 'Pick today task',
        detail: 'Choose the first step that can be finished today without extra setup.',
        output: 'One focused task ready to start now.',
      },
      {
        id: 'execute',
        title: isCoding ? 'Execute with Build Workspace' : 'Execute focused work',
        detail: isCoding
          ? 'Use the build workspace to implement or inspect the needed change.'
          : 'Draft, research, decide, or produce the promised output.',
        output: 'A tangible artifact, decision, or completed task.',
      },
      {
        id: 'verify',
        title: 'Verify result',
        detail: verification,
        output: 'A clear pass/fail or quality check.',
      },
      {
        id: 'learn',
        title: 'Save learning back to Life OS',
        detail: 'Record what changed, what worked, and the next recommended action.',
        output: 'Updated memory, decision, risk, or next action.',
      },
    ],
    risks: [
      'Scope can become too broad if the first step is not small.',
      'The plan needs user review before MCIS treats it as trusted context.',
    ],
    successCriteria: [
      'One visible output is completed.',
      'A verification result is recorded.',
      'MCIS saves one learning or next action back to Life OS.',
    ],
    todayTask: `Start with the smallest visible step for: ${objective}`,
    chatPrompt: `Create and run a 5-step MCIS agent work loop for this Life OS action: ${objective}`,
  };
}

async function createAgentPlan(task = '', context = {}) {
  if (!process.env.GROQ_API_KEY || !groq) {
    return fallbackAgentPlan(task, context);
  }

  try {
    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'system',
          content: `Create an autonomous agent work loop for MCIS.
Return ONLY valid JSON:
{
  "objective":"...",
  "estimatedMinutes":45,
  "mode":"build|research|execution|study|strategy",
  "tools":["..."],
  "steps":[{"id":"break-down","title":"...","detail":"...","output":"..."}],
  "risks":["..."],
  "successCriteria":["..."],
  "todayTask":"...",
  "chatPrompt":"..."
}
The steps must follow: Break goal into tasks, Pick today task, Execute/code/research, Verify result, Save learning back to Life OS.
Write every "detail", "risk", and "successCriteria" entry in plain, non-technical English a non-engineer product owner can understand in one read — explain the point of a technical step, not just its implementation name. Keep each under ~140 characters.`,
        },
        {
          role: 'user',
          content: `Task:\n${task}\n\nContext:\n${JSON.stringify(context || {}, null, 2).slice(0, 1800)}`,
        },
      ],
      max_tokens: 800,
      temperature: 0.35,
      reasoning_effort: 'none',
    });

    const raw = completion.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!parsed.objective || !Array.isArray(parsed.steps)) {
      return fallbackAgentPlan(task, context);
    }

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      objective: cleanText(parsed.objective, 180),
      estimatedMinutes: Number(parsed.estimatedMinutes || 45),
      mode: parsed.mode || 'execution',
      tools: Array.isArray(parsed.tools) ? parsed.tools.slice(0, 6) : fallbackAgentPlan(task, context).tools,
      steps: parsed.steps.slice(0, 6),
      risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 5) : [],
      successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria.slice(0, 5) : [],
      todayTask: cleanText(parsed.todayTask || `Start: ${task}`, 180),
      chatPrompt: cleanText(parsed.chatPrompt || `Run an MCIS agent work loop for: ${task}`, 260),
    };
  } catch (err) {
    logger.info(`Agent plan AI fallback used: ${err.message}`);
    return fallbackAgentPlan(task, context);
  }
}

module.exports = {
  OPERATING_CATEGORIES,
  extractAndSaveOperatingContext,
  heuristicExtract,
  simulateLite,
  createAgentPlan,
};