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
const { askAI } = require('../services/ai');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HIGH_RISK_ACTIONS = [
  'delete_file', 'delete_folder', 'move_file', 'move_folder', 'rename_file', 'rename_folder',
  'write_file', 'run_terminal', 'kill_process', 'close_app', 'close_window', 'login',
];

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

router.post('/', async (req, res) => {
  let userId = await resolveUserId(req);

  if (!userId) {
    const devBypassAllowed =
      process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNAUTHENTICATED_API === 'true';

    if (devBypassAllowed) {
      userId = 'test-user-123';
    } else {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { message, deviceId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  const fastMatch = tryFastPath(message);
  const intent = fastMatch
    ? { type: 'action', action: fastMatch.action, payload: fastMatch.payload }
    : await (async () => { const t0 = Date.now(); const r = await classifyIntent(message); console.log('[TIMING] classifyIntent:', Date.now() - t0, 'ms'); return r; })();
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
    const needsConfirmation = HIGH_RISK_ACTIONS.includes(intent.action);
    const targetResource =
      intent.payload.parameters?.path ||
      intent.payload.parameters?.url ||
      intent.payload.parameters?.appName ||
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

      if (intent.action === 'type_text' && result.success) {
        recordDictation(userId, intent.payload);
      }
      logAction(userId, intent.action, intent.payload, result).catch(() => {});
      appendAuditLog(userId, intent.action, intent.payload, result).catch(() => {});
      return res.json({ type: 'nexus_action', action: intent.action, result });
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

  const needsConfirmation = HIGH_RISK_ACTIONS.includes(intent.action);
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