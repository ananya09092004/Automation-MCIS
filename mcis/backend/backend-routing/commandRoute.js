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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Nexus actions that require approval before running (see nexus/docs/09_supported_actions.md)
const HIGH_RISK_ACTIONS = [
  'delete_file', 'delete_folder', 'move_file', 'move_folder', 'rename_file', 'rename_folder',
  'write_file', 'run_terminal', 'kill_process', 'close_app', 'close_window', 'login',
];

// Tracks each user's most recent *successful* type_text call so consecutive
// dictation commands ("ye likh: X" ... then later "ab yeh likh: Y") land on
// a new line instead of gluing onto the previous text — type_text itself
// just types at the current cursor position (see nexus/desktop/keyboard),
// it has no concept of "this is a fresh line of dictation" on its own.
// Cleared automatically if the user switches app/target or goes quiet for
// a while, so it never bleeds into an unrelated later typing action.
const DICTATION_CONTINUITY_MS = 5 * 60 * 1000;
const lastDictation = new Map(); // userId -> { app, target, at }

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

async function resolveUserId(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
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
  return data.user_id;
}

router.post('/', async (req, res) => {
  const userId = await resolveUserId(req) || 'test-user-123';
  const { message, deviceId } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  const fastMatch = tryFastPath(message);
  const intent = fastMatch
    ? { type: 'action', action: fastMatch.action, payload: fastMatch.payload }
    : await classifyIntent(message);
  if (intent.type === 'chat') {
    return res.json({
      type: 'chat',
      message: intent.message || 'Route this to your existing /api/chat handler on the frontend',
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

  // --- Multi-step goal (task planner) ---
  // Runs in the background so this HTTP request returns immediately instead
  // of blocking for the whole goal (which can take up to MAX_STEPS * up to
  // ~30s per step). The client polls GET /api/command/goal/:planId/status.
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

  // --- Nexus-routed actions (action names already match Nexus's vocabulary) ---
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
      // If this is another type_text into the SAME app/target as the user's
      // last dictation (within the last few minutes), prefix a newline so
      // it lands as a new line instead of gluing onto the previous text.
      if (intent.action === 'type_text' && shouldPrefixNewline(userId, intent.payload)) {
        const currentValue = intent.payload.value ?? '';
        if (!currentValue.startsWith('\n')) {
          intent.payload = { ...intent.payload, value: '\n' + currentValue };
        }
      } else if (intent.action === 'type_text') {
        // Fresh dictation target — nothing to prefix, just start tracking it.
      } else if (intent.action === 'open_app' || intent.action === 'navigate') {
        // Switching context resets dictation continuity for this user.
        forgetDictation(userId);
      }

      const result = await sendCommandToNexus({
        platform: intent.payload.platform || 'desktop',
        action: intent.action,
        parameters: intent.payload.parameters || {},
        target: intent.payload.target || {},
        value: intent.payload.value || null,
        approval_token: intent.payload.approval_token || null
      });
      if (intent.action === 'type_text' && result.success) {
        recordDictation(userId, intent.payload);
      }
      await logAction(userId, intent.action, intent.payload, result);
      await appendAuditLog(userId, intent.action, intent.payload, result);
      return res.json({ type: 'nexus_action', action: intent.action, result });
    } catch (err) {
      await appendAuditLog(userId, intent.action, intent.payload, err);
      return res.status(500).json({ type: 'nexus_action', action: intent.action, error: err.message });
    }
  }

  // --- Node Desktop Agent fallback (legacy) ---
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
    await logAction(userId, intent.action, intent.payload, result);
    await appendAuditLog(userId, intent.action, intent.payload, result);
    res.json({ type: 'action', action: intent.action, result });
  } catch (err) {
    await appendAuditLog(userId, intent.action, intent.payload, err);
    res.status(500).json({ type: 'action', action: intent.action, error: err });
  }
});

// --- Goal status polling (for the background run_goal above) ---
router.get('/goal/:planId/status', (req, res) => {
  const status = taskPlanner.getPlanStatus(req.params.planId);
  if (status.type === 'plan_error' && !status.status) {
    return res.status(404).json(status);
  }
  res.json(status);
});

// --- Answer a mid-goal clarifying question ("kaunsa restaurant?" etc) ---
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