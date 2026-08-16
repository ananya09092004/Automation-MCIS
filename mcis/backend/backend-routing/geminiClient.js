const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Ordered fallback chain — quota is per-model (not per-key), so if the
// primary model's daily quota is exhausted, trying a different model name
// with the SAME key gets a fresh quota bucket. Never falls back to 2.x
// models (deprecated/shut down) — only current 3.x free-tier models.
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

// Tries each model in order. Returns the first successful result, or
// throws the last error if every model in the chain fails.
async function generateContent(prompt) {
  let lastError;

  for (const { name, client } of models) {
    try {
      const result = await client.generateContent(prompt);
      return result;
    } catch (err) {
      lastError = err;
      if (isQuotaError(err)) {
        console.warn(`Gemini model "${name}" quota exhausted, trying next in chain...`);
        continue;
      }
      // Non-quota error (network, invalid request) — no point trying
      // other models for the same bad request, but try once more anyway
      // in case it was a transient blip.
      continue;
    }
  }

  throw lastError;
}

module.exports = { generateContent };