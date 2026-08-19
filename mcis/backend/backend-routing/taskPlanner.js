const { generateContent } = require('./geminiClient');
const { sendCommandToNexus } = require('./nexusBridge');
const { NEXUS_ACTIONS } = require('./intentRouter');

const SENSITIVE_KEYWORDS = [
  'password', 'card', 'cvv', 'otp', 'pay', 'checkout',
  'confirm order', 'place order', 'submit payment', 'login'
];

const MAX_STEPS = 15;
const STEP_TIMEOUT_MS = 30000;
const MAX_DATA_CHARS = 2500;

const plans = new Map();
let emergencyStopActive = false;

// How long a finished plan (completed/error/stopped) stays queryable via
// getPlanStatus() before being garbage-collected from memory.
const FINISHED_PLAN_TTL_MS = 15 * 60 * 1000;

function makePlanId() {
  return 'plan_' + Math.random().toString(36).slice(2, 10);
}

function scheduleCleanup(planId) {
  setTimeout(() => plans.delete(planId), FINISHED_PLAN_TTL_MS).unref?.();
}

// Snapshot of a plan safe to send to clients (no internal-only fields).
function snapshot(plan) {
  if (!plan) return null;
  return {
    planId: plan.planId,
    goal: plan.goal,
    status: plan.status, // running | paused | awaiting_clarification | completed | error | stopped
    steps: plan.history,
    pendingStep: plan.pendingStep || null,
    pendingQuestion: plan.pendingQuestion || null,
    result: plan.result || null,
  };
}

function isSensitiveStep(step) {
  const actionText = String(step.action || '').toLowerCase();
  const valuesText = JSON.stringify(step.payload || {}).toLowerCase();
  const combined = `${actionText} ${valuesText}`;
  return SENSITIVE_KEYWORDS.some(word => {
    const pattern = new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i');
    return pattern.test(combined);
  });
}

function triggerEmergencyStop() {
  emergencyStopActive = true;
  plans.clear();
  return { stopped: true };
}

function clearEmergencyStop() {
  emergencyStopActive = false;
}

async function callNexusWithTimeout(action, payload) {
  const call = sendCommandToNexus({
    platform: payload.platform || 'desktop',
    action,
    parameters: payload.parameters || {},
    target: payload.target || {},
    value: payload.value || null,
    approval_token: null,
  });
  const timeout = new Promise(resolve =>
    setTimeout(() => resolve({ success: false, error: `Timed out after ${STEP_TIMEOUT_MS / 1000}s` }), STEP_TIMEOUT_MS)
  );
  return Promise.race([call, timeout]);
}

function truncate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > MAX_DATA_CHARS ? text.slice(0, MAX_DATA_CHARS) + '...(truncated)' : text;
}

async function decideNextStep(goal, history, clarifications = []) {
  const historyText = history.map((h, i) => {
    const evidence = h.evidence ? ` | verified: ${h.evidence.verified}` : '';
    const dataPreview = h.data ? `\n   page/data seen: ${truncate(h.data)}` : '';
    return `${i + 1}. ${h.action} -> ${h.success ? 'success' : 'failed: ' + h.error}${evidence}${dataPreview}`;
  }).join('\n') || '(none yet)';

  const clarificationsText = clarifications.length
    ? clarifications.map((c, i) => `Q${i + 1}: ${c.question}\nA${i + 1}: ${c.answer}`).join('\n')
    : '(none)';

  const prompt = `You are Nexus's autonomous task planner. The user's goal: "${goal}"

Steps executed so far:
${historyText}

Clarifications already asked and answered by the user (use these, don't ask again):
${clarificationsText}

Valid nexus actions: ${NEXUS_ACTIONS.join(', ')}

Parameter key names Nexus expects (use these exact keys):
- open_app, close_app, focus_app, minimize_app, maximize_app, switch_to_app: parameters: { "app": "<app name>" }
- navigate: parameters: { "url": "<full url>" }
- open_file, read_file, write_file, create_file, delete_file, search_file: parameters: { "path": "<file path>" }
- create_folder, delete_folder, search_folder: parameters: { "path": "<folder path>" }
- type_text, fill: value: "<text to type>", target: { "selector"/"role"/"name": "<what to type into>" }
- click, double_click, right_click: target: { "selector"/"role"/"name": "<what to click>" }
- inspect_page, inspect_page_state, read_text: parameters: {} — returns the actual visible elements/text on the current page

INSPECT ONLY WHEN NEEDED — keep this system fast:
- Desktop actions (open_app, type_text into a desktop app, file/folder ops, etc.) NEVER need
  inspect_page — skip it entirely for desktop platform.
- "navigate" never needs inspect_page first — just navigate directly.
- ONLY call "inspect_page" (or "read_text") immediately before a click/fill/type/select that
  targets a SPECIFIC element on a browser page whose exact selector you don't already have from
  a PREVIOUS inspect in this same run since the last navigate.
- If you already inspected the current page earlier in the history (no navigate happened since),
  reuse that data — do NOT inspect the same page twice in a row.
- If the last step's data shows an error, CAPTCHA, or login wall, don't blindly retry the same
  click — adjust or stop and report it.
- Default to acting directly without inspecting whenever the action doesn't require picking a
  specific on-page element.

WRITING CONTENT INTO AN APP (e.g. "notepad kholo aur ek paragraph likh do", "open notepad and
write a paragraph about X"):
- This is a TWO-step pattern: (1) open_app to launch the app (e.g. "Notepad"), (2) type_text
  with the content as the "value" field, target: { "role": "editor" }.
- PRIORITY: if the user already dictated/gave the actual text to type (anywhere in the goal
  text, e.g. "notepad khol aur yeh likh: <text>"), copy it into payload.value VERBATIM — do not
  paraphrase, shorten, or rewrite it. The user's own words always win.
- Only if the goal gives a topic but NO literal text to type (e.g. "notepad khol aur ek
  paragraph likh do <topic> pe", with no dictated sentences) should you compose the paragraph
  yourself, in the language the user asked in, on-topic, 4-6 sentences.
- If the goal gives neither literal text NOR a topic (e.g. just "notepad khol aur likh do" with
  nothing else) — this is exactly the case to use needs_clarification (below) and ask what to
  write, rather than inventing content out of nothing.

ASKING THE USER FOR MORE INFO (mid-goal clarification):
- If you cannot make progress because a REQUIRED piece of information is missing and cannot be
  inferred (e.g. "book a table" with no restaurant name, "email X" with no recipient) — do NOT
  guess and do NOT invent an action. Instead respond with:
  { "done": false, "needs_clarification": true, "question": "<short question in the user's language>", "action": null }
- Only do this when truly stuck — prefer making a reasonable assumption and proceeding whenever
  possible, since pausing costs the user time.

Decide the SINGLE next action to make progress toward the goal, or declare the goal complete.
Respond ONLY with JSON, no markdown:
{ "done": true|false, "needs_clarification": false, "question": null, "action": "<nexus action name or null>", "payload": { "platform": "desktop"|"browser", "parameters": {}, "target": {}, "value": null }, "reason": "<short reason>" }`;

  let result;
  try {
    result = await generateContent(prompt);
  } catch (err) {
    console.error('decideNextStep Gemini error (all models failed):', err.message);
    return { done: true, action: null, reason: 'AI system abhi busy hai, thodi der baad try karo.' };
  }

  const text = result.response.text().trim().replace(/```json|```/g, '');
  try {
    return JSON.parse(text);
  } catch {
    return { done: true, action: null, reason: 'planner_parse_error' };
  }
}

async function runLoop(plan) {
  while (plan.history.length < MAX_STEPS) {

    if (emergencyStopActive) {
      plan.status = 'error';
      plan.result = { type: 'plan_error', message: 'Emergency stop activate hai — koi automation nahi chalega.' };
      scheduleCleanup(plan.planId);
      return plan.result;
    }

    const next = await decideNextStep(plan.goal, plan.history, plan.clarifications);

    if (next.needs_clarification) {
      plan.status = 'awaiting_clarification';
      plan.pendingQuestion = next.question || 'Thoda aur detail de sakte ho?';
      plan.result = null;
      // Do NOT delete/cleanup — plan stays alive waiting for submitClarification().
      return {
        type: 'plan_awaiting_clarification',
        planId: plan.planId,
        message: plan.pendingQuestion,
        resource: `plan:${plan.planId}`,
      };
    }

    if (next.done) {
      plan.status = 'completed';
      plan.result = { type: 'plan_complete', message: next.reason || 'Goal achieved.', steps: plan.history };
      scheduleCleanup(plan.planId);
      return plan.result;
    }

    if (!next.action || !NEXUS_ACTIONS.includes(next.action)) {
      plan.status = 'error';
      plan.result = { type: 'plan_error', message: 'Planner produced an invalid step.' };
      scheduleCleanup(plan.planId);
      return plan.result;
    }

    if (isSensitiveStep(next)) {
      plan.status = 'paused';
      plan.pendingStep = next;
      return {
        type: 'plan_paused',
        planId: plan.planId,
        message: `Agla step ("${next.action}") sensitive lag raha hai (login/payment). Approve karein?`,
        resource: `plan:${plan.planId}`,
      };
    }

    let result = await callNexusWithTimeout(next.action, next.payload);
    const isVerified = result.evidence?.verified !== false;

    if (!result.success || !isVerified) {
      await new Promise(r => setTimeout(r, 1500));
      result = await callNexusWithTimeout(next.action, next.payload);
    }

    plan.history.push({
      action: next.action,
      success: result.success,
      error: result.error,
      evidence: result.evidence ? { verified: result.evidence.verified } : null,
      data: result.data || null,
    });

    if (!result.success) {
      plan.status = 'error';
      plan.result = { type: 'plan_error', message: `Step "${next.action}" failed even after retry: ${result.error}`, steps: plan.history };
      scheduleCleanup(plan.planId);
      return plan.result;
    }
  }

  plan.status = 'stopped';
  plan.result = { type: 'plan_stopped', message: 'Max steps tak pahunch gaye, goal complete nahi hua.', steps: plan.history };
  scheduleCleanup(plan.planId);
  return plan.result;
}

function newPlan(userId, goal) {
  const planId = makePlanId();
  const plan = { planId, userId, goal, history: [], clarifications: [], status: 'running', pendingStep: null, pendingQuestion: null, result: null };
  plans.set(planId, plan);
  return plan;
}

// --- Synchronous (blocking) API — kept for any existing callers. ---
async function startPlan(userId, goal) {
  if (emergencyStopActive) {
    return { type: 'plan_error', message: 'Emergency stop activate hai — pehle resume karo.' };
  }
  const plan = newPlan(userId, goal);
  return runLoop(plan);
}

async function resumePlan(planId) {
  if (emergencyStopActive) {
    return { type: 'plan_error', message: 'Emergency stop activate hai.' };
  }
  const plan = plans.get(planId);
  if (!plan) {
    return { type: 'plan_error', message: 'Plan nahi mila ya expire ho gaya.' };
  }
  plan.status = 'running';
  plan.pendingStep = null;
  return runLoop(plan);
}

// --- Background (non-blocking) API — use these for goal execution so the
// HTTP request returns immediately; the caller polls getPlanStatus(planId). ---
function startPlanAsync(userId, goal) {
  if (emergencyStopActive) {
    return { type: 'plan_error', message: 'Emergency stop activate hai — pehle resume karo.' };
  }
  const plan = newPlan(userId, goal);
  // Fire and forget — errors are captured onto the plan itself so polling
  // always has something sensible to report, never an unhandled rejection.
  runLoop(plan).catch(err => {
    plan.status = 'error';
    plan.result = { type: 'plan_error', message: err.message };
    scheduleCleanup(plan.planId);
  });
  return { type: 'plan_started', planId: plan.planId, status: 'running' };
}

function resumePlanAsync(planId) {
  if (emergencyStopActive) {
    return { type: 'plan_error', message: 'Emergency stop activate hai.' };
  }
  const plan = plans.get(planId);
  if (!plan) {
    return { type: 'plan_error', message: 'Plan nahi mila ya expire ho gaya.' };
  }
  plan.status = 'running';
  plan.pendingStep = null;
  runLoop(plan).catch(err => {
    plan.status = 'error';
    plan.result = { type: 'plan_error', message: err.message };
    scheduleCleanup(plan.planId);
  });
  return { type: 'plan_started', planId: plan.planId, status: 'running' };
}

// Answer a mid-goal clarifying question and resume execution in the background.
function submitClarification(planId, answer) {
  const plan = plans.get(planId);
  if (!plan) {
    return { type: 'plan_error', message: 'Plan nahi mila ya expire ho gaya.' };
  }
  if (plan.status !== 'awaiting_clarification') {
    return { type: 'plan_error', message: 'Ye plan clarification ka wait nahi kar raha.' };
  }
  plan.clarifications.push({ question: plan.pendingQuestion, answer });
  plan.pendingQuestion = null;
  plan.status = 'running';
  runLoop(plan).catch(err => {
    plan.status = 'error';
    plan.result = { type: 'plan_error', message: err.message };
    scheduleCleanup(plan.planId);
  });
  return { type: 'plan_started', planId: plan.planId, status: 'running' };
}

function getPlanStatus(planId) {
  const plan = plans.get(planId);
  if (!plan) {
    return { type: 'plan_error', message: 'Plan nahi mila ya expire ho gaya.' };
  }
  return snapshot(plan);
}

module.exports = {
  startPlan,
  resumePlan,
  startPlanAsync,
  resumePlanAsync,
  submitClarification,
  getPlanStatus,
  triggerEmergencyStop,
  clearEmergencyStop,
  // Exported so other orchestration experiments (e.g. hybridOrchestrator's
  // teaching mode) can reuse the same step-decision/execution primitives
  // instead of re-implementing (and re-diverging from) this logic.
  decideNextStep,
  isSensitiveStep,
  callNexusWithTimeout,
};