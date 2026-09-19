const { generateContent } = require('./geminiClient');
const { sendCommandToNexus } = require('./nexusBridge');
const { NEXUS_ACTIONS, SAFE_TO_REPEAT_ACTIONS } = require('./intentRouter');
const taskContext = require('./taskContext');
const { classifyRisk } = require('./riskModel');

const MAX_STEPS = 15;
const STEP_TIMEOUT_MS = 30000;
const MAX_DATA_CHARS = 2500;

// PASS 3: bounded recovery -- how many CONSECUTIVE step failures (across
// possibly-different, adapted actions, not just repeats of the same one)
// are tolerated before giving up on the goal entirely. This is the
// "stop after bounded recovery attempts" requirement -- resets to 0 on
// any successful step, so a goal with occasional hiccups can still run
// its full MAX_STEPS; only a genuinely stuck goal (nothing working
// several times in a row) aborts early instead of burning through all
// of MAX_STEPS on a goal that's never going to succeed.
const MAX_CONSECUTIVE_FAILURES = 3;

// Bounded, generic (not workflow-specific) diagnostic action per
// platform, used ONLY when a NON-idempotent step fails (see
// diagnoseFailure below) -- both already exist as real Nexus actions,
// nothing new was added to the action vocabulary for this.
const DIAGNOSTIC_ACTION_BY_PLATFORM = {
  browser: 'inspect_page_state',
  desktop: 'inspect_screen_state',
};

async function diagnoseFailure(step) {
  const platform = step.payload?.platform;
  const diagnosticAction = DIAGNOSTIC_ACTION_BY_PLATFORM[platform];
  if (!diagnosticAction || !NEXUS_ACTIONS.includes(diagnosticAction)) return null;
  try {
    const diag = await callNexusWithTimeout(diagnosticAction, { platform, parameters: {}, target: {}, value: null });
    return diag.success ? (diag.data || diag.evidence || null) : null;
  } catch {
    // The diagnostic call itself failing is not fatal -- just means we
    // proceed to replan without extra state information, same as before
    // this pass existed.
    return null;
  }
}


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

// PASS 2: this used to be its own separate SENSITIVE_KEYWORDS list/
// isSensitiveStep() function, duplicating commandRoute.js's HIGH_RISK_
// ACTIONS list. Both are now driven by the single shared riskModel.js
// so the two execution paths (single-command and multi-step plan)
// agree on what's risky instead of maintaining two lists that could
// drift apart. Only RED blocks with a confirmation pause, matching the
// old isSensitiveStep behavior exactly; YELLOW is new (see runLoop
// below) and does not block.
function isSensitiveStep(step) {
  return classifyRisk(step.action, step.payload) === 'red';
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
    const diagnosisPreview = h.diagnosis ? `\n   state after failure: ${truncate(h.diagnosis)}` : '';
    return `${i + 1}. ${h.action} -> ${h.success ? 'success' : 'failed: ' + h.error}${evidence}${dataPreview}${diagnosisPreview}`;
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

STARTING A "NEW DOCUMENT/FILE" IN AN APP (e.g. "notepad me nayi file banao", "start a fresh
document in notepad", "I need a blank document"): the app itself must end up showing a new/blank
document — NEVER use "create_file" for this, it only silently writes an empty file to disk and
opens nothing. If the app isn't running yet, "open_app" alone already gives a fresh document. If
it's already running, use "hotkey" with parameters: { "keys": ["ctrl", "n"] } targeting that app's
window instead.

OPENING A "NEW WINDOW" (any app, including a browser, e.g. "open another chrome window", "naya
window kholo"): same mechanism as above — if the app isn't running, "open_app" already gives a
fresh window; if it's already running, "hotkey" with parameters: { "keys": ["ctrl", "n"] } is the
real OS-level new-window shortcut for the vast majority of Windows apps. There is no separate
"new_window" nexus action, so don't invent one. This differs from "new tab" in a browser, which is
its own dedicated "new_tab" action (opens a tab in the SAME window, not a new OS window).

ASKING THE USER FOR MORE INFO (mid-goal clarification):
- If you cannot make progress because a REQUIRED piece of information is missing and cannot be
  inferred (e.g. "book a table" with no restaurant name, "email X" with no recipient) — do NOT
  guess and do NOT invent an action. Instead respond with:
  { "done": false, "needs_clarification": true, "question": "<short question in the user's language>", "action": null }
- Only do this when truly stuck — prefer making a reasonable assumption and proceeding whenever
  possible, since pausing costs the user time.

SOFTWARE-ENGINEERING GOALS ("find this bug and fix it", "run the tests and fix failures",
"refactor this function", "review these changes"): compose the SAME existing file/terminal actions
used for everything else — there is no separate coding action set. A typical sequence:
  1. search_file / list_folder to discover the repo's actual layout — never assume file names,
     language, or framework; look at what's actually there.
  2. read_file on the files that look relevant to the goal (found via step 1 or named by the user).
  3. run_terminal to discover and run the project's OWN test/build command (e.g. look for a
     package.json/pytest.ini/Makefile via search_file first rather than guessing a fixed command
     like "npm test" or "pytest" blindly — different repos use different tools).
  4. Diagnose failures from the terminal output (this is exactly the "state after failure"
     mechanism above — a failing test run's output IS the diagnostic signal for what to fix next).
  5. write_file with the corrected content once you understand the fix — read_file first if you
     haven't already, since write_file replaces the whole file content and you need to know what's
     actually there to preserve everything except the actual fix.
  6. run_terminal again to re-run tests and confirm the fix actually works — do not report success
     without this verification step.
  7. run_terminal with a diff/status command (e.g. discovered via the repo's own tooling) to review
     what actually changed before considering the goal complete.
This is not a special workflow — run_terminal is already a RED-risk action (requires the existing
confirmation gate) and write_file is already YELLOW (already verified more carefully) exactly like
any other use of these actions elsewhere. Do not push/commit/create external GitHub changes
without that same existing confirmation gate; local inspection/diff/read operations don't need it.

RECOVERING FROM A FAILED STEP (see "failed: ..." entries above, possibly with a "state after
failure" line): a failure does NOT mean repeat the identical action again — it already was
retried once automatically if that was safe to do, and you're seeing it in history precisely
because that didn't resolve it. Instead:
- Use the "state after failure" info (if present) to understand what actually happened — e.g. the
  page never navigated, a dialog is blocking the page, the wrong window is focused — and choose a
  DIFFERENT next action that addresses that actual state, not a copy of the failed one.
- If the failure suggests a UI/selector/target problem, consider an inspection action
  (inspect_page/inspect_page_state for browser, active_window/inspect_screen_state for desktop)
  as your next step to re-locate the right target before trying again.
- If two or three different approaches have all failed and you have no more reasonable ideas, use
  needs_clarification to ask the user rather than continuing to guess indefinitely.
- Never propose the exact same non-idempotent action (typing, clicking a submit/send/pay control,
  deleting, downloading) a second time on unclear/ambiguous grounds — if you're not confident it's
  safe to repeat, ask instead.

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

    const __stepStart = Date.now();
    let result = await callNexusWithTimeout(next.action, next.payload);
    let diagnosis = null;
    let recoveryAttempted = false;

    if (!result.success) {
      recoveryAttempted = true;
      if (SAFE_TO_REPEAT_ACTIONS.includes(next.action)) {
        // Idempotent/read-only action (open_app, navigate, inspect_page,
        // etc.) -- safe to just try again as-is, same as before this
        // pass. A transient failure (app briefly busy, page still
        // loading) is the common case here and a plain retry resolves
        // it without needing any diagnosis.
        await new Promise(r => setTimeout(r, 1500));
        result = await callNexusWithTimeout(next.action, next.payload);
      } else {
        // Non-idempotent action failed (typing, clicking, submitting,
        // deleting, downloading, ...). Blindly resending the exact same
        // action/payload risks double-executing something that may have
        // partially gone through. Instead: one bounded, generic state
        // inspection (see diagnoseFailure) to understand what actually
        // happened, then let the NEXT planning iteration (below) decide
        // how to adapt -- a different selector, a different approach,
        // or asking the user -- using that state as context, instead of
        // this function guessing a fixed recovery recipe itself.
        diagnosis = await diagnoseFailure(next);
      }
    }

    const riskTier = classifyRisk(next.action, next.payload); // 'green' | 'yellow' | 'red' (red already handled above via isSensitiveStep)

    // Minimal structured observability -- cheap (one synchronous stdout
    // write, no network/DB call, so this never touches the hot path's
    // latency budget). Deliberately a single flat line so it's greppable
    // in logs without a log-aggregation setup: planId, step index,
    // action, riskTier, success, verified, whether recovery was
    // attempted, and step duration.
    console.log(JSON.stringify({
      planId: plan.planId,
      step: plan.history.length + 1,
      action: next.action,
      riskTier,
      success: result.success,
      verified: result.evidence?.verified ?? null,
      recoveryAttempted,
      durationMs: Date.now() - __stepStart,
    }));

    plan.history.push({
      action: next.action,
      success: result.success,
      error: result.error,
      evidence: result.evidence ? { verified: result.evidence.verified } : null,
      data: result.data || null,
      diagnosis,
      riskTier,
      // YELLOW: "stronger verification, don't silently guess" -- this
      // costs nothing extra (result.evidence is already returned by
      // callNexusWithTimeout), it just means a YELLOW step whose own
      // verification came back ambiguous is recorded honestly rather
      // than reported the same as a cleanly-verified GREEN step.
      verificationNote: (riskTier === 'yellow' && result.success && result.evidence?.verified === false)
        ? 'Action reported success but could not be independently verified.'
        : null,
    });

    // If this step's success returned structured, comparable results
    // (e.g. read_tables returning search-result rows), make them
    // available to a LATER, separate command ("show me the first one",
    // "compare that with the second") via the task context layer --
    // otherwise entity references like "the first one" have nothing to
    // resolve against once this HTTP request/response is over.
    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      taskContext.setResults(plan.userId, result.data);
    }
    taskContext.recordAction(plan.userId, next.action, next.payload);

    if (!result.success) {
      // PASS 3: was an immediate hard-abort of the entire goal on any
      // step that failed twice (the identical action, blindly retried
      // once). Now: only abort after MAX_CONSECUTIVE_FAILURES steps in a
      // row have failed -- this is the "bounded recovery attempts"
      // requirement. Under that bound, the loop continues instead of
      // returning here, so the NEXT decideNextStep call sees this
      // failure (plus the diagnosis captured above) in history and can
      // propose an ADAPTED next action -- a different selector, a
      // different capability, or a clarifying question -- rather than
      // the goal dying on the first non-idempotent hiccup.
      plan.consecutiveFailures = (plan.consecutiveFailures || 0) + 1;
      if (plan.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        plan.status = 'error';
        plan.result = {
          type: 'plan_error',
          message: `${MAX_CONSECUTIVE_FAILURES} attempts in a row failed on "${next.action}": ${result.error}`,
          steps: plan.history,
        };
        scheduleCleanup(plan.planId);
        return plan.result;
      }
      // Under the bound -- fall through to the top of the while loop,
      // which calls decideNextStep again with this failure now part of
      // plan.history.
    } else {
      plan.consecutiveFailures = 0;
    }
  }

  plan.status = 'stopped';
  plan.result = { type: 'plan_stopped', message: 'Max steps tak pahunch gaye, goal complete nahi hua.', steps: plan.history };
  scheduleCleanup(plan.planId);
  return plan.result;
}

function newPlan(userId, goal) {
  const planId = makePlanId();
  const plan = { planId, userId, goal, history: [], clarifications: [], status: 'running', pendingStep: null, pendingQuestion: null, result: null, consecutiveFailures: 0 };
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