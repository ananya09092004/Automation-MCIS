/**
 * FIX: reasoning models (e.g. qwen/qwen3.6-27b on Groq) sometimes emit their
 * internal reasoning wrapped in <think>...</think> BEFORE the actual answer,
 * even when explicitly told "return ONLY valid JSON, no explanation". Every
 * call site across the codebase that did:
 *
 *   JSON.parse(text.replace(/```json|```/g, '').trim())
 *
 * only stripped markdown code fences, not <think> blocks, so any response
 * that included reasoning failed with "Unexpected token '<'... is not valid
 * JSON" and silently skipped the feature (suggestions, recommendations, etc).
 *
 * Use `safeJsonParse(text)` in place of raw JSON.parse for any LLM output
 * that's expected to be JSON.
 */

function stripThinkTags(text) {
  // Remove complete <think>...</think> blocks (case-insensitive, multiline)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Some models emit an unclosed <think> tag if truncated — drop everything
  // from an opening <think> onward as a fallback.
  if (/<think>/i.test(cleaned)) {
    cleaned = cleaned.split(/<think>/i)[0];
  }
  return cleaned;
}

function stripCodeFences(text) {
  return text.replace(/```json|```/gi, '');
}

/**
 * Extracts the first valid top-level JSON value (object or array) from a
 * blob of text that may have reasoning/prose before or after it.
 */
function extractJsonSubstring(text) {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');

  let start = -1;
  let openChar, closeChar;
  if (objStart === -1 && arrStart === -1) return text; // nothing bracket-like, let JSON.parse fail naturally
  if (objStart === -1) { start = arrStart; openChar = '['; closeChar = ']'; }
  else if (arrStart === -1) { start = objStart; openChar = '{'; closeChar = '}'; }
  else if (objStart < arrStart) { start = objStart; openChar = '{'; closeChar = '}'; }
  else { start = arrStart; openChar = '['; closeChar = ']'; }

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start); // unbalanced — return what we have, let JSON.parse report the real error
}

/**
 * Drop-in replacement for JSON.parse(text.replace(/```json|```/g, '').trim())
 * Handles: <think> reasoning blocks, markdown code fences, and leading/
 * trailing prose around the actual JSON payload.
 */
function safeJsonParse(rawText) {
  const withoutThink = stripThinkTags(rawText);
  const withoutFences = stripCodeFences(withoutThink).trim();
  const jsonSubstring = extractJsonSubstring(withoutFences);
  return JSON.parse(jsonSubstring);
}

module.exports = { safeJsonParse, stripThinkTags, stripCodeFences, extractJsonSubstring };