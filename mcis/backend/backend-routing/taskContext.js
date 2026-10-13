/**
 * Lightweight per-user TASK context layer.
 *
 * This is deliberately separate from MCIS's own long-term memory system
 * (memory-hooks/memoryHooks.js) -- that's durable, cross-session user
 * memory (preferences, facts about the user). This is short-lived,
 * transient EXECUTION context: what goal is currently active, what
 * results were last shown, what was last done -- exactly what's needed
 * to resolve a follow-up like "make it under 7000" or "open the first
 * one" without re-stating the whole request every time. It expires on
 * its own; nothing here is meant to persist beyond an active task.
 *
 * This module only stores/retrieves state. It does not itself do any
 * language understanding -- callers (commandRoute.js, intentRouter.js,
 * taskPlanner.js) decide when to read/write it and how to use it.
 */

"use strict";

// How long a context stays alive with no activity before it's treated
// as stale and a fresh one is started. 30 minutes covers "still on the
// same task" without accumulating context forever for an abandoned one.
const CONTEXT_TTL_MS = 30 * 60 * 1000;

// Cap on how many extracted results we keep/expose per context -- this
// is task context, not a database. Enough for "show me the first one" /
// "compare the top 3", not meant to hold thousands of rows.
const MAX_RESULTS = 20;

const contexts = new Map(); // userId -> context object

function _now() {
  return Date.now();
}

function _fresh() {
  return {
    activeGoal: null, // { goal: string, planId: string|null, constraints: object, at: number }
    lastResults: [],  // [{ index: number, data: any }]
    lastAction: null, // { action: string, at: number }
    pendingClarification: null, // { question: string, originalMessage: string, at: number }
    updatedAt: _now(),
  };
}

/** Get (or lazily create) the context for a user, expiring a stale one. */
function getContext(userId) {
  if (!userId) return _fresh(); // no identity to key on -- caller gets a throwaway, never persisted
  const existing = contexts.get(userId);
  if (existing && _now() - existing.updatedAt < CONTEXT_TTL_MS) {
    return existing;
  }
  const fresh = _fresh();
  contexts.set(userId, fresh);
  return fresh;
}

/** Record the goal currently being worked on (starts a new "active task"). */
function setActiveGoal(userId, goal, planId = null) {
  if (!userId) return;
  const ctx = getContext(userId);
  ctx.activeGoal = { goal, planId, constraints: {}, at: _now() };
  ctx.updatedAt = _now();
}

/** Merge new constraints into the CURRENT active goal (e.g. budget changed). */
function updateConstraints(userId, patch) {
  if (!userId || !patch) return;
  const ctx = getContext(userId);
  if (!ctx.activeGoal) return;
  ctx.activeGoal.constraints = { ...ctx.activeGoal.constraints, ...patch };
  ctx.updatedAt = _now();
}

/** Store the latest extracted/comparable result set (search results, table rows, etc). */
function setResults(userId, results) {
  if (!userId || !Array.isArray(results)) return;
  const ctx = getContext(userId);
  ctx.lastResults = results.slice(0, MAX_RESULTS).map((data, i) => ({ index: i + 1, data }));
  ctx.updatedAt = _now();
}

/** Record the most recent action taken, for "same thing again"/"undo that"-style references. */
function recordAction(userId, action, payload) {
  if (!userId) return;
  const ctx = getContext(userId);
  ctx.lastAction = { action, payload: payload || null, at: _now() };
  ctx.updatedAt = _now();
}

/**
 * A compact, prompt-ready view of the context -- deliberately small
 * (capped result count, no huge nested payloads) so it's cheap to drop
 * into a classifier/planner prompt. Returns null when there's nothing
 * useful to add, so callers can skip the extra prompt text entirely for
 * a fresh conversation with no prior task.
 */
function toPromptContext(userId) {
  if (!userId) return null;
  const ctx = getContext(userId);
  if (!ctx.activeGoal && ctx.lastResults.length === 0 && !ctx.lastAction && !ctx.pendingClarification) {
    return null;
  }
  return {
    activeGoal: ctx.activeGoal
      ? { goal: ctx.activeGoal.goal, constraints: ctx.activeGoal.constraints }
      : null,
    resultCount: ctx.lastResults.length,
    results: ctx.lastResults.slice(0, 10),
    lastAction: ctx.lastAction ? { action: ctx.lastAction.action } : null,
    pendingClarification: ctx.pendingClarification
      ? { question: ctx.pendingClarification.question, originalMessage: ctx.pendingClarification.originalMessage }
      : null,
  };
}

/**
 * Record that Nexus just asked the user a clarifying question (e.g.
 * "Which one do you mean?") -- the NEXT message from this user is very
 * likely the answer to it, not a fresh unrelated request, so callers
 * should surface this to the classifier before the next classifyIntent
 * call. Cleared automatically the next time classification runs
 * (regardless of whether it was actually used) so a stale question
 * never lingers and gets attached to an unrelated later message.
 */
function setPendingClarification(userId, question, originalMessage) {
  if (!userId) return;
  const ctx = getContext(userId);
  ctx.pendingClarification = { question, originalMessage, at: _now() };
  ctx.updatedAt = _now();
}

function getPendingClarification(userId) {
  if (!userId) return null;
  const ctx = getContext(userId);
  return ctx.pendingClarification;
}

function clearPendingClarification(userId) {
  if (!userId) return;
  const ctx = getContext(userId);
  ctx.pendingClarification = null;
}

/** Explicitly end the current task context (e.g. user says "start fresh" / "never mind"). */
function clearContext(userId) {
  if (!userId) return;
  contexts.delete(userId);
}

module.exports = {
  getContext,
  setActiveGoal,
  updateConstraints,
  setResults,
  recordAction,
  toPromptContext,
  clearContext,
  setPendingClarification,
  getPendingClarification,
  clearPendingClarification,
  CONTEXT_TTL_MS,
};
