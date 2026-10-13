const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const GEMINI_MODEL = 'gemini-3.6-flash'; // fast tier — default for most messages
const GEMINI_MODEL_DEEP = 'gemini-3.1-pro'; // accuracy tier — complex/reasoning-heavy queries only
// Har message pe heavy model use karna speed target (1-2s) todta hai, isliye
// deep tier sirf tab lagta hai jab planner ne complexity/intent se signal diya ho.
function selectGeminiModel(plan = {}) {
  const heavyIntents = ['code_generation', 'debugging', 'architecture', 'planning'];
  const isComplex = plan.complexity === 'high' || heavyIntents.includes(plan.intent);
  return isComplex ? GEMINI_MODEL_DEEP : GEMINI_MODEL;
}

const MODEL_CHAIN = [
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];

function getExtraParamsForModel(model) {
  if (model === 'qwen/qwen3.6-27b') {
    return { reasoning_effort: 'none' };
  }

  if (model === 'openai/gpt-oss-120b' || model === 'openai/gpt-oss-20b') {
    return { reasoning_effort: 'low', reasoning_format: 'hidden' };
  }

  return {};
}

function routeQuery(message = '') {
  const lower = message.toLowerCase();
  const wordCount = lower.trim().split(/\s+/).filter(Boolean).length;

  const simplePatterns = [
    'hi',
    'hello',
    'hey',
    'thanks',
    'ok',
    'bye',
    'what is',
    'who is',
    'when is',
    'where is',
    'how are',
  ];

  const complexPatterns = [
    'analyze',
    'architecture',
    'build',
    'compare',
    'create',
    'debug',
    'design',
    'explain',
    'project',
    'refactor',
    'research',
    'write code',
    'banao',
    'likhao',
    'project',
    'samjhao',
  ];

  const isSimple = wordCount <= 8 || simplePatterns.some(pattern => lower.startsWith(pattern));
  const isComplex = wordCount > 24 || complexPatterns.some(pattern => lower.includes(pattern));

  if (isSimple && !isComplex) return 'openai/gpt-oss-20b';
  return 'qwen/qwen3.6-27b';
}

function detectLanguage(message = '') {
  const hindiChars = /[\u0900-\u097F]/;
  if (hindiChars.test(message)) return 'HINDI';

  const lower = message.toLowerCase();
  const hinglishWords = [
    'aaj',
    'abhi',
    'acha',
    'accha',
    'aur',
    'banao',
    'bata',
    'batao',
    'bilkul',
    'hai',
    'haan',
    'kaise',
    'kar',
    'karo',
    'kya',
    'matlab',
    'mera',
    'meri',
    'nahi',
    'samjhao',
    'theek',
    'toh',
  ];

  const count = hinglishWords.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(lower)).length;
  return count >= 1 ? 'HINGLISH' : 'ENGLISH';
}

function getSystemPrompt(memoryContext = '') {
  return `
You are MCIS - Memory Centric Intelligence System.

Core behavior:
- Be direct, practical, and useful.
- Use the user's saved context only when it helps.
- Prefer concrete next steps over generic motivation.
- When uncertainty matters, say what you are assuming.

Language rule:
Every user message starts with a [LANGUAGE: XX] tag.
Reply in exactly that language.

[LANGUAGE: ENGLISH] = English only.
[LANGUAGE: HINDI] = Hindi only.
[LANGUAGE: HINGLISH] = Natural Hinglish.

Never mention the language tag or explain the language choice.

${memoryContext ? `\nUSER CONTEXT:\n${memoryContext}` : ''}
`;
}

function normalizeAssistantContent(message) {
  if (!message) return '';
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (typeof message.text === 'string') content = message.text;
  // Strip think tags
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return content;
}

async function tryWithFallback(createCompletion) {
  const errors = [];

  for (const model of MODEL_CHAIN) {
    try {
      return await createCompletion(model);
    } catch (err) {
      const message = err?.message || 'Unknown model error';
      errors.push(`${model}: ${message}`);

      const isRetryable =
        err?.status === 408 ||
        err?.status === 409 ||
        err?.status === 429 ||
        err?.status >= 500 ||
        message.toLowerCase().includes('rate') ||
        message.toLowerCase().includes('quota') ||
        message.toLowerCase().includes('timeout');

      if (!isRetryable) throw err;
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  }

  throw new Error(`All models failed. Errors: ${errors.join(' | ')}`);
}

function formatHistory(history = []) {
  return history.slice(-8).flatMap(item => ([
    { role: 'user', content: item.message?.slice(0, 500) || '' },
    { role: 'assistant', content: item.response?.slice(0, 500) || '' },
  ])).filter(item => item.content);
}

// Converts Groq-style {role: 'user'|'assistant', content} history into
// Gemini-style {role: 'user'|'model', parts: [{text}]} contents.
function toGeminiContents(historyMessages, latestUserMessage) {
  const contents = historyMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: latestUserMessage }] });
  return contents;
}

function isRetryableGeminiError(err) {
  const message = (err?.message || '').toLowerCase();
  const status = err?.status || err?.response?.status;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    message.includes('rate') ||
    message.includes('quota') ||
    message.includes('timeout') ||
    message.includes('unavailable') ||
    message.includes('overloaded')
  );
}

async function askGemini(systemContent, historyMessages, taggedMessage) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemContent,
  });

  const contents = toGeminiContents(historyMessages, taggedMessage);
  const result = await model.generateContent({ contents });
  const content = result.response.text()?.trim();
  if (!content) throw new Error('Gemini returned empty content');
  return content;
}

async function askGeminiStream(systemContent, historyMessages, userMessage, maxTokens, modelName = GEMINI_MODEL) {
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemContent,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  });

  const contents = toGeminiContents(historyMessages, userMessage);
  const result = await model.generateContentStream({ contents });

  // Wrap Gemini's stream so it yields chunks shaped like Groq's stream
  // (chunk.choices[0].delta.content), so calling code doesn't need to change.
  return (async function* groqShapedStream() {
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        yield { choices: [{ delta: { content: text } }] };
      }
    }
  })();
}

async function askAI(userMessage, memoryContext = '', history = [], searchContext = '') {
  const selectedModel = routeQuery(userMessage);
  const language = detectLanguage(userMessage);
  const taggedMessage = `[LANGUAGE: ${language}]\n${userMessage}`;
  const systemContent = getSystemPrompt(memoryContext) +
    (searchContext ? `\n\nREAL-TIME WEB DATA:\n${searchContext}` : '');

  if (genAI) {
    try {
      return await askGemini(systemContent, formatHistory(history), taggedMessage);
    } catch (err) {
      console.error('Gemini failed, falling back to Groq:', err?.message || err);
      if (!isRetryableGeminiError(err)) {
        // Still fall back to Groq even on non-retryable errors here,
        // since Groq is our safety net — but log it clearly.
      }
    }
  }

  return await tryWithFallback(async fallbackModel => {
    const model = fallbackModel === MODEL_CHAIN[0] ? selectedModel : fallbackModel;
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemContent },
        ...formatHistory(history),
        { role: 'user', content: taggedMessage },
      ],
      model,
      max_tokens: 4096,
      temperature: 0.7,
      ...getExtraParamsForModel(model),
    });

    const content = normalizeAssistantContent(completion.choices?.[0]?.message);
    if (!content) throw new Error(`Model ${model} returned empty content`);
    return content;
  });
}

async function askAIStream(userMessage, systemPrompt, history = [], searchContext = '', maxTokens = 4096, plan = {}) {
  const fullSystem = systemPrompt + (searchContext ? `\n\nREAL-TIME WEB DATA:\n${searchContext}` : '');
  const geminiModel = selectGeminiModel(plan);

  if (genAI) {
    try {
      return await askGeminiStream(fullSystem, formatHistory(history), userMessage, maxTokens, geminiModel);
    } catch (err) {
      console.error(`Gemini stream (${geminiModel}) failed, falling back to Groq:`, err?.message || err);
    }
  }

  return await tryWithFallback(async model => {
    return await groq.chat.completions.create({
      messages: [
        { role: 'system', content: fullSystem },
        ...formatHistory(history),
        { role: 'user', content: userMessage },
      ],
      model,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
      ...getExtraParamsForModel(model),
    });
  });
}

module.exports = {
  askAI,
  askAIStream,
  detectLanguage,
  routeQuery,
};