const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const getFirebaseAdmin = require('../config/firebaseAdmin');
const { classifyIntent, NEXUS_ACTIONS } = require('../backend-routing/intentRouter');
const { sendCommandToAgent } = require('../agentSocket');
const { sendCommandToNexus } = require('../backend-routing/nexusBridge');
const taskPlanner = require('../backend-routing/taskPlanner');
const { logAction } = require('../memory-hooks/memoryHooks');
const { isPermitted } = require('../security-engine/permissions');
const { appendAuditLog } = require('../security-engine/auditLog');
const aiTasks = require('../ai-tasks/aiTasks');
const productivity = require('../productivity/productivity');
const calendar = require('../productivity/calendar');
const { tryFastPath } = require('../backend-routing/fastPath');
const taskContext = require('../backend-routing/taskContext');
const { classifyRisk } = require('../backend-routing/riskModel');
const { askAI } = require('../services/ai');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// PASS 2: the old flat HIGH_RISK_ACTIONS list (and needsConfirmation
// checks below) is superseded by riskModel.js's 3-tier GREEN/YELLOW/RED
// classification -- see that file for the actual action/keyword sets.
// Kept as a rename-in-place at each call site rather than removed
// outright, so the diff here is minimal and behavior stays traceable.

const DICTATION_CONTINUITY_MS = 5 * 60 * 1000;
const lastDictation = new Map();

function dictationTargetKey(payload) {
  const app = payload?.parameters?.app || payload?.platform || '';
  const target = JSON.stringify(payload?.target || {});
  return `${app}::${target}`;
}

function shouldPrefixNewline(userId, payload) {
  const prev = lastDictation.get(userId);
  if (!prev) return false;
  if (Date.now() - prev.at > DICTATION_CONTINUITY_MS) return false;
  return prev.key === dictationTargetKey(payload);
}

function recordDictation(userId, payload) {
  lastDictation.set(userId, { key: dictationTargetKey(payload), at: Date.now() });
}

function forgetDictation(userId) {
  lastDictation.delete(userId);
}

const AI_TASK_HANDLERS = {
  draftEmail: aiTasks.draftEmail,
  customizeResume: aiTasks.customizeResume,
  research: aiTasks.research,
  generateCode: aiTasks.generateCode,
  fixBug: aiTasks.fixBug,
  summarizeMeeting: aiTasks.summarizeMeeting,
  takeNotes: aiTasks.takeNotes,
  translate: aiTasks.translate
};

const PRODUCTIVITY_HANDLERS = {
  addReminder: (userId, p) => productivity.addReminder(userId, p.text, p.dueAt),
  addTodo: (userId, p) => productivity.addTodo(userId, p.text),
  completeTodo: (userId, p) => productivity.completeTodo(userId, p.todoId),
  getDailyBriefing: (userId) => productivity.getDailyBriefing(userId),
  createCalendarEvent: (userId, p) => calendar.createEvent(userId, p),
  listUpcomingEvents: (userId, p) => calendar.listUpcomingEvents(userId, p.maxResults)
};

const USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const userIdCache = new Map();

// nexus/voice/voice_controller.py never sent an Authorization header at
// all -- every voice command hit resolveUserId() with token=null,  fell
// straight through to the NODE_ENV/ALLOW_UNAUTHENTICATED_API dev-bypass
// check below, and got 'test-user-123' ONLY if that flag happened to be
// set. In any environment where it wasn't (e.g. NODE_ENV=production on
// a real deploy), every single voice command would 401 with no other
// symptom. This is a real, lightweight device-secret check instead --
// no network round trip (unlike the Firebase/Supabase path below), and
// it doesn't depend on a "for testing" flag to work at all.
const VOICE_DEVICE_TOKEN = process.env.NEXUS_VOICE_DEVICE_TOKEN || null;

function resolveVoiceDeviceUserId(req) {
  if (!VOICE_DEVICE_TOKEN) return null;
  const provided = req.headers['x-device-token'];
  if (!provided || provided !== VOICE_DEVICE_TOKEN) return null;
  const deviceId = req.body?.deviceId || 'voice-device';
  return `voice-device:${deviceId}`;
}

async function resolveUserId(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const cached = userIdCache.get(token);
  if (cached && Date.now() - cached.at < USER_ID_CACHE_TTL_MS) {
    return cached.userId;
  }

  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    userIdCache.set(token, { userId: decoded.uid, at: Date.now() });
    return decoded.uid;
  } catch {
    // not a valid Firebase token — fall through to device token check
  }

  const { data, error } = await supabase
    .from('device_tokens')
    .select('user_id')
    .eq('token', token)
    .single();

  if (error || !data) return null;
  userIdCache.set(token, { userId: data.user_id, at: Date.now() });
  return data.user_id;
}

// Voice-side retries (voice_controller.py's _post_command, on a dropped
// connection) resend the SAME commandId rather than a fresh one, so a
// case where attempt 1 actually reached this route and started
// executing but the response never made it back to the client (network
// blip on the way out, not the way in) doesn't silently run the same
// action twice. Short TTL -- this is only meant to catch a retry that
// lands a few seconds later, not to be a general dedupe store.
const RECENT_COMMAND_TTL_MS = 30 * 1000;
const recentCommandIds = new Map(); // commandId -> timestamp

function isDuplicateCommand(commandId) {
  if (!commandId) return false; // no id supplied (e.g. other callers) -- nothing to dedupe against
  const now = Date.now();
  for (const [id, at] of recentCommandIds) {
    if (now - at > RECENT_COMMAND_TTL_MS) recentCommandIds.delete(id);
  }
  if (recentCommandIds.has(commandId)) return true;
  recentCommandIds.set(commandId, now);
  return false;
}

router.post('/', async (req, res) => {
  // Fast, no-network path first: a trusted local voice device with the
  // shared secret skips the Firebase/Supabase round trip entirely
  // (this is most of what was making every command pay an extra
  // network hop before it could even start). Falls through to the
  // existing Firebase/Supabase/dev-bypass resolution unchanged for
  // every other caller (MCIS web UI, mobile app, etc.) -- nothing
  // about that path is touched.
  let userId = resolveVoiceDeviceUserId(req) || await resolveUserId(req);

  if (!userId) {
    const devBypassAllowed =
      process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNAUTHENTICATED_API === 'true';

    if (devBypassAllowed) {
      userId = 'test-user-123';
    } else {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { message, deviceId, commandId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  if (isDuplicateCommand(commandId)) {
    console.warn(`[commandRoute] Duplicate commandId ${commandId} within ${RECENT_COMMAND_TTL_MS}ms, skipping re-execution.`);
    return res.json({ type: 'chat', message: 'Already on it -- one sec.' });
  }

  const fastMatch = tryFastPath(message);
  const intent = fastMatch
    ? { type: 'action', action: fastMatch.action, payload: fastMatch.payload }
    : await (async () => {
        const t0 = Date.now();
        // Give the classifier the user's current task context (if any) so
        // a follow-up like "make it under 7000" or "only ones near the
        // beach" gets folded into a complete, standalone goal instead of
        // being classified blind -- see taskContext.js. This also carries
        // any pendingClarification (Nexus just asked something last turn)
        // so THIS message can be resolved as the answer to that question.
        const r = await classifyIntent(message, taskContext.toPromptContext(userId));
        console.log('[TIMING] classifyIntent:', Date.now() - t0, 'ms');
        // Whether or not it was actually used, a pending clarification is
        // now stale after this classification -- clear it so a LATER,
        // unrelated message never gets mistakenly treated as an answer to
        // an old question.
        taskContext.clearPendingClarification(userId);
        return r;
      })();

  if (intent.type === 'clarify') {
    // The request was actionable but underspecified (ambiguous reference,
    // no/insufficient context, or an unsafe "do that again" repeat) --
    // ask instead of guessing wrong. Remember the question so the user's
    // next message can be resolved as its answer.
    taskContext.setPendingClarification(userId, intent.question, message);
    return res.json({ type: 'clarification_needed', message: intent.question });
  }

  if (intent.type === 'chat') {
    return res.json({
      type: 'chat',
      message: await askAI(message, '', [], ''),
    });
  }

  if (AI_TASK_HANDLERS[intent.action]) {
    try {
      const output = await AI_TASK_HANDLERS[intent.action](intent.payload);
      await logAction(userId, intent.action, intent.payload, { success: true });
      return res.json({ type: 'ai_task', action: intent.action, output });
    } catch (err) {
      return res.status(500).json({ type: 'ai_task', action: intent.action, error: err.message });
    }
  }

  if (intent.action === 'run_goal') {
    try {
      const started = taskPlanner.startPlanAsync(userId, intent.payload.goal);
      // Record this as the user's active task -- taskPlanner.js updates
      // it further as the plan produces results, so a LATER, separate
      // command ("make it cheaper", "open the first one") can reference
      // this goal/its results without repeating the whole request.
      taskContext.setActiveGoal(userId, intent.payload.goal, started.planId || null);
      await logAction(userId, 'run_goal', intent.payload, started);
      return res.json(started);
    } catch (err) {
      return res.status(500).json({ type: 'plan_error', error: err.message });
    }
  }

  if (PRODUCTIVITY_HANDLERS[intent.action]) {
    try {
      const output = await PRODUCTIVITY_HANDLERS[intent.action](userId, intent.payload);
      return res.json({ type: 'productivity', action: intent.action, output });
    } catch (err) {
      return res.status(500).json({ type: 'productivity', action: intent.action, error: err.message });
    }
  }

  if (NEXUS_ACTIONS.includes(intent.action)) {
    const riskTier = classifyRisk(intent.action, intent.payload);
    const needsConfirmation = riskTier === 'red';
    const targetResource =
      intent.payload.parameters?.path ||
      intent.payload.parameters?.url ||
      intent.payload.parameters?.app ||
      intent.action;
    const permitted = await isPermitted(userId, targetResource);

    if (needsConfirmation || !permitted) {
      return res.status(403).json({
        type: 'permission_required',
        message: needsConfirmation
          ? `"${intent.action}" is high-risk on "${targetResource}" — please confirm.`
          : `First-time access to "${targetResource}" needs your approval.`,
        action: intent.action,
        payload: intent.payload,
        resource: targetResource
      });
    }

    try {
      if (intent.action === 'type_text' && shouldPrefixNewline(userId, intent.payload)) {
        const currentValue = intent.payload.value ?? '';
        if (!currentValue.startsWith('\n')) {
          intent.payload = { ...intent.payload, value: '\n' + currentValue };
        }
      } else if (intent.action === 'type_text') {
        // Fresh dictation target — nothing to prefix, just start tracking it.
      } else if (intent.action === 'open_app' || intent.action === 'navigate') {
        forgetDictation(userId);
      }

      const __t0 = Date.now();
      const result = await sendCommandToNexus({
        platform: intent.payload.platform || 'desktop',
        action: intent.action,
        parameters: intent.payload.parameters || {},
        target: intent.payload.target || {},
        value: intent.payload.value || null,
        approval_token: intent.payload.approval_token || null
      });
      console.log('[TIMING] sendCommandToNexus:', Date.now() - __t0, 'ms');

      // YELLOW tier: "stronger verification, don't silently guess" --
      // this costs nothing extra (result.evidence is already returned by
      // sendCommandToNexus, no additional call), it just means a YELLOW
      // action whose own verification came back ambiguous is reported
      // honestly instead of a flat "Done" the same way a GREEN action
      // would be. GREEN/RED responses are completely unchanged.
      if (riskTier === 'yellow' && result?.success && result?.evidence?.verified === false) {
        result.verificationNote = 'Action reported success but could not be independently verified.';
      }

      if (intent.action === 'type_text' && result.success) {
        recordDictation(userId, intent.payload);
      }
      logAction(userId, intent.action, intent.payload, result).catch(() => {});
      appendAuditLog(userId, intent.action, intent.payload, result).catch(() => {});
      return res.json({ type: 'nexus_action', action: intent.action, result, riskTier });
    } catch (err) {
      appendAuditLog(userId, intent.action, intent.payload, err).catch(() => {});
      return res.status(500).json({ type: 'nexus_action', action: intent.action, error: err.message });
    }
  }

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId required for laptop actions' });
  }

  const targetResource = intent.payload.appName || intent.payload.filePath ||
    intent.payload.folderPath || intent.payload.packageName || intent.payload.command;

  const needsConfirmation = classifyRisk(intent.action, intent.payload) === 'red';
  const permitted = await isPermitted(userId, targetResource);

  if (needsConfirmation || !permitted) {
    return res.status(403).json({
      type: 'permission_required',
      message: needsConfirmation
        ? `"${intent.action}" is high-risk on "${targetResource}" — please confirm.`
        : `First-time access to "${targetResource}" needs your approval.`,
      action: intent.action,
      payload: intent.payload,
      resource: targetResource
    });
  }

  try {
    const result = await sendCommandToAgent(userId, deviceId, intent.action, intent.payload);
    logAction(userId, intent.action, intent.payload, result).catch(() => {});
    appendAuditLog(userId, intent.action, intent.payload, result).catch(() => {});
    res.json({ type: 'action', action: intent.action, result });
  } catch (err) {
    appendAuditLog(userId, intent.action, intent.payload, err).catch(() => {});
    res.status(500).json({ type: 'action', action: intent.action, error: err });
  }
});

router.get('/goal/:planId/status', (req, res) => {
  const status = taskPlanner.getPlanStatus(req.params.planId);
  if (status.type === 'plan_error' && !status.status) {
    return res.status(404).json(status);
  }
  res.json(status);
});

router.post('/goal/:planId/answer', async (req, res) => {
  const { answer } = req.body;
  if (!answer) {
    return res.status(400).json({ error: 'answer required' });
  }
  const result = taskPlanner.submitClarification(req.params.planId, answer);
  await logAction(req.body.userId || 'test-user-123', 'goal_clarification_answer', { planId: req.params.planId, answer }, result);
  res.json(result);
});

module.exports = router;