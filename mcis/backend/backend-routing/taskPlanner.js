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

function makePlanId() {
  return 'plan_' + Math.random().toString(36).slice(2, 10);
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

async function decideNextStep(goal, history) {
  const historyText = history.map((h, i) => {
    const evidence = h.evidence ? ` | verified: ${h.evidence.verified}` : '';
    const dataPreview = h.data ? `\n   page/data seen: ${truncate(h.data)}` : '';
    return `${i + 1}. ${h.action} -> ${h.success ? 'success' : 'failed: ' + h.error}${evidence}${dataPreview}`;
  }).join('\n') || '(none yet)';

  const prompt = `You are Nexus's autonomous task planner. The user's goal: "${goal}"

Steps executed so far:
${historyText}

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
Decide the SINGLE next action to make progress toward the goal, or declare the goal complete.
Respond ONLY with JSON, no markdown:
{ "done": true|false, "action": "<nexus action name or null>", "payload": { "platform": "desktop"|"browser", "parameters": {}, "target": {}, "value": null }, "reason": "<short reason>" }`;

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
      plans.delete(plan.planId);
      return { type: 'plan_error', message: 'Emergency stop activate hai — koi automation nahi chalega.' };
    }

    const next = await decideNextStep(plan.goal, plan.history);

    if (next.done) {
      plans.delete(plan.planId);
      return { type: 'plan_complete', message: next.reason || 'Goal achieved.', steps: plan.history };
    }

    if (!next.action || !NEXUS_ACTIONS.includes(next.action)) {
      plans.delete(plan.planId);
      return { type: 'plan_error', message: 'Planner produced an invalid step.' };
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
      plans.delete(plan.planId);
      return { type: 'plan_error', message: `Step "${next.action}" failed even after retry: ${result.error}`, steps: plan.history };
    }
  }

  plans.delete(plan.planId);
  return { type: 'plan_stopped', message: 'Max steps tak pahunch gaye, goal complete nahi hua.', steps: plan.history };
}

async function startPlan(userId, goal) {
  if (emergencyStopActive) {
    return { type: 'plan_error', message: 'Emergency stop activate hai — pehle resume karo.' };
  }
  const planId = makePlanId();
  const plan = { planId, userId, goal, history: [], status: 'running' };
  plans.set(planId, plan);
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
  return runLoop(plan);
}

module.exports = { startPlan, resumePlan, triggerEmergencyStop, clearEmergencyStop };