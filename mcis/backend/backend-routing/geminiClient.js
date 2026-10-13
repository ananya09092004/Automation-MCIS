const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_CHAIN = [
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

const models = MODEL_CHAIN.map(name => ({ name, client: genAI.getGenerativeModel({ model: name }) }));

function isQuotaError(err) {
  return err && err.message && (err.message.includes('429') || err.message.includes('quota'));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Flash-tier models are built for low latency -- if one hasn't responded
// within this window it's clearly having an issue, not just being
// thorough. Lower timeout keeps the worst case (all 4 models in
// MODEL_CHAIN slow/unresponsive) bounded at ~10s instead of ~16s,
// without shrinking the fallback chain itself (still tries all 4 on
// quota/network errors, which typically fail near-instantly anyway).
const PER_MODEL_TIMEOUT_MS = 2500;

async function generateContent(prompt) {
  let lastError;
  for (const { name, client } of models) {
    try {
      const result = await withTimeout(client.generateContent(prompt), PER_MODEL_TIMEOUT_MS, name);
      return result;
    } catch (err) {
      lastError = err;
      if (isQuotaError(err)) {
        console.warn(`Gemini model "${name}" quota exhausted, trying next in chain...`);
      } else {
        console.warn(`Gemini model "${name}" failed/slow (${err.message}), trying next in chain...`);
      }
      continue;
    }
  }
  throw lastError;
}

module.exports = { generateContent };