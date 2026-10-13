// backend/services/hybridOrchestrator.js
//
// "Teaching mode" goal executor: like taskPlanner's autonomous run_goal,
// but streams step-by-step progress and (in LEARN/HYBRID mode) short
// explanations of *why* each step was taken, via EventEmitter so
// routes/hybrid.js can pipe it straight into an SSE response.
//
// This file was previously broken dead code: modeSelector, planGenerator,
// explanationGenerator, variantGenerator, learningProgress, currentLevel
// and currentDifficulty were all referenced but never required/defined —
// hitting POST /:userId/execute-goal threw a ReferenceError immediately.
// Rewritten below to:
//   - actually require its dependencies
//   - reuse taskPlanner's step-decision/execution primitives instead of
//     a non-existent planGenerator (there's no "generate the whole plan
//     up front" component anywhere in this codebase — steps are decided
//     one at a time, same as the regular autonomous goal runner)
//   - be an EventEmitter, since routes/hybrid.js calls .on(...) on the
//     return value of executeGoal()
//   - track per-user skill level in a small in-memory store instead of
//     referencing undefined globals (currentLevel/currentDifficulty)

const { EventEmitter } = require('events');
const modeSelector = require('./modeSelector');
const explanationGenerator = require('./explanationGenerator');
const variantGenerator = require('./variantGenerator');
const { decideNextStep, isSensitiveStep, callNexusWithTimeout } = require('../backend-routing/taskPlanner');
const { NEXUS_ACTIONS } = require('../backend-routing/intentRouter');

const MAX_STEPS = 15;

// Simple in-memory per-user skill tracking. There's no `learningProgress`
// table/service anywhere in this codebase yet — swap this for a real DB
// write (e.g. a Supabase `learning_progress` table) when one exists.
const skillLevels = new Map(); // userId -> { level, skills: Set }

function getSkillState(userId) {
  if (!skillLevels.has(userId)) {
    skillLevels.set(userId, { level: 1, skills: new Set() });
  }
  return skillLevels.get(userId);
}

class HybridOrchestrator extends EventEmitter {
  /**
   * Kicks off background execution and returns `this` immediately so the
   * caller can attach 'step-complete' / 'teaching-moment' / 'growth-update'
   * / 'complete' / 'error' listeners (see routes/hybrid.js).
   */
  executeGoal(userId, goal) {
    // Run async without blocking the caller; all progress goes out as events.
    this._run(userId, goal).catch(err => {
      this.emit('error', { message: err.message });
    });
    return this;
  }

  async _run(userId, goal) {
    const mode = await modeSelector.selectMode(userId, goal);
    const history = [];
    const learnings = [];

    for (let i = 0; i < MAX_STEPS; i++) {
      const next = await decideNextStep(goal, history);

      if (next.needs_clarification) {
        this.emit('teaching-moment', {
          whatHappened: 'Paused for input',
          whyThisApproach: next.question || 'Need more detail to continue.',
          patternToRemember: null,
          challenge: null,
        });
        this.emit('complete', {
          goal,
          status: 'awaiting_clarification',
          question: next.question,
          execution: history,
          learnings,
        });
        return;
      }

      if (next.done) break;

      if (!next.action || !NEXUS_ACTIONS.includes(next.action)) {
        this.emit('error', { message: 'Planner produced an invalid step.' });
        return;
      }

      if (isSensitiveStep(next)) {
        this.emit('complete', {
          goal,
          status: 'paused_for_approval',
          message: `Next step ("${next.action}") needs approval (sensitive/login/payment).`,
          execution: history,
          learnings,
        });
        return;
      }

      // === EXECUTE ===
      const execution = await callNexusWithTimeout(next.action, next.payload);
      const step = { name: next.action, importance: next.importance || 'normal', isNewPattern: !!next.isNewPattern, pattern: next.action, trigger: next.reason, solution: next.action, context: next.payload };
      history.push({ action: next.action, success: execution.success, error: execution.error, data: execution.data || null });

      this.emit('step-complete', { step: step.name, output: execution });

      // === TEACH (smart interrupts) ===
      if (this.shouldTeach(step, mode)) {
        const teaching = await this.generateTeaching(userId, step, execution);
        learnings.push(teaching);
        this.emit('teaching-moment', teaching);
      }

      // === VERIFY ===
      if (!execution.success) {
        this.emit('error', { message: `Step "${next.action}" failed: ${execution.error}`, execution: history });
        return;
      }

      // === INTERMEDIATE REPORT ===
      if (i > 0 && i % 3 === 0) {
        this.emit('growth-update', {
          skillsGained: learnings.length,
          levelBefore: getSkillState(userId).level,
          levelAfter: getSkillState(userId).level,
        });
      }
    }

    // === FINAL SUMMARY ===
    const growth = await this.calculateGrowth(userId, learnings);
    this.emit('growth-update', growth);
    this.emit('complete', {
      goal,
      status: 'completed',
      execution: history,
      learnings,
      userGrowth: growth,
      nextChallenge: await this.generateNextChallenge(userId, learnings),
    });
  }

  shouldTeach(step, mode) {
    if (mode === 'LEARN') return true;
    if (mode === 'EXECUTE') return false;

    // HYBRID: teach only for steps flagged as high-importance/new-pattern
    // by the planner. Most steps won't set these, so HYBRID mode stays
    // mostly quiet by default — that's expected, not a bug.
    return step.importance === 'high' && step.isNewPattern === true;
  }

  async generateTeaching(userId, step, execution) {
    return {
      whatHappened: `Step "${step.name}" was executed`,
      whyThisApproach: await explanationGenerator.generateReasoning(step.name, step.pattern),
      whyNotAlternatives: await explanationGenerator.explainAlternatives(step.name, step.pattern),
      patternToRemember: step.pattern,
      nextTime: step.trigger ? `Watch for: ${step.trigger}` : undefined,
      challenge: await variantGenerator.createVariant({ pattern: step.pattern, difficulty: getSkillState(userId).level, context: step.context }),
    };
  }

  async calculateGrowth(userId, learnings) {
    const state = getSkillState(userId);
    const levelBefore = state.level;
    const newSkills = learnings.map(l => l.patternToRemember).filter(Boolean);
    newSkills.forEach(s => state.skills.add(s));
    if (newSkills.length > 0) state.level = Math.min(10, state.level + 1);

    return {
      skillsGained: newSkills.length,
      levelBefore,
      levelAfter: state.level,
      readyForHarderGoals: state.level > levelBefore,
    };
  }

  async generateNextChallenge(userId, learnings) {
    if (learnings.length === 0) return null;
    const skillsJustLearned = learnings.map(l => l.patternToRemember).filter(Boolean);
    if (skillsJustLearned.length === 0) return null;
    const state = getSkillState(userId);

    return {
      goal: `Apply ${skillsJustLearned[0]} in a different context`,
      difficulty: Math.min(10, state.level + 1),
      estimatedTime: 15,
      relatesTo: skillsJustLearned,
      hint: learnings[0].nextTime || `Remember: ${skillsJustLearned[0]}`,
    };
  }
}

// Exported as the CLASS, not a singleton instance. A shared singleton
// EventEmitter would leak events across concurrent goals from different
// users/requests (request A's listeners would also receive request B's
// 'step-complete' events). routes/hybrid.js does `new HybridOrchestrator()`
// per request instead.
module.exports = HybridOrchestrator;
