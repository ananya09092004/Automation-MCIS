// backend/services/hybridOrchestrator.js

class HybridOrchestrator {
  async executeGoal(userId, goal) {
    // 1. Select mode
    const mode = await modeSelector.selectMode(userId, goal);
    
    // 2. Create execution plan
    const plan = await planGenerator.createPlan(goal);
    
    // 3. Execute with pauses
    const result = await this.executeWithTeaching(
      userId, 
      plan, 
      mode
    );
    
    return result;
  }

  async executeWithTeaching(userId, plan, mode) {
    const steps = plan.steps; // [step1, step2, step3...]
    const results = [];
    const learnings = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      // === EXECUTE ===
      const execution = await this.executeStep(step);
      results.push(execution);

      // === TEACH (Smart interrupts) ===
      if (this.shouldTeach(step, mode)) {
        const teaching = await this.generateTeaching(
          userId, 
          step, 
          execution
        );
        learnings.push(teaching);
      }

      // === VERIFY ===
      const verified = await this.verifyStep(execution);
      if (!verified.success) {
        await this.rollback();
        throw new Error(verified.error);
      }

      // === INTERMEDIATE REPORT ===
      if (i % 3 === 0) {
        await this.sendProgressUpdate(userId, {
          completed: i + 1,
          total: steps.length,
          learnings: learnings.slice(-2)
        });
      }
    }

    // === FINAL SUMMARY ===
    return {
      goal,
      status: 'completed',
      execution: results,
      learnings,
      userGrowth: await this.calculateGrowth(userId, learnings),
      nextChallenge: await this.generateNextChallenge(userId, learnings)
    };
  }

  shouldTeach(step, mode) {
    if (mode === 'LEARN') return true;
    if (mode === 'EXECUTE') return false;
    
    // HYBRID: Teach only if:
    // - This is a critical decision point
    // - User doesn't know this pattern
    // - It's worth learning
    
    return step.importance === 'high' && 
           step.isNewPattern === true;
  }

  async generateTeaching(userId, step, execution) {
    return {
      whatHappened: `Step ${step.name} was executed`,
      whyThisApproach: await explanationGenerator.explain(step),
      whyNotAlternatives: await this.explainAlternatives(step),
      patternToRemember: step.pattern,
      nextTime: `Watch for ${step.trigger} - use ${step.solution}`,
      challenge: await variantGenerator.createVariant(step)
    };
  }

  async calculateGrowth(userId, learnings) {
    const newSkills = learnings.map(l => l.patternToRemember);
    
    // Update user profile
    await learningProgress.update(userId, {
      newSkillsGained: newSkills,
      skillLevel: await this.calculateNewLevel(userId, newSkills),
      nextDifficultyLevel: Math.min(10, currentLevel + 1)
    });

    return {
      skillsGained: newSkills.length,
      levelBefore: currentLevel,
      levelAfter: currentLevel + 1,
      readyForHarderGoals: true
    };
  }

  async generateNextChallenge(userId, learnings) {
    const skillsJustLearned = learnings.map(l => l.patternToRemember);
    
    // Similar problem, slightly harder
    return {
      goal: `Apply ${skillsJustLearned[0]} in a different context`,
      difficulty: currentDifficulty + 1,
      estimatedTime: 25,
      relatesTo: skillsJustLearned,
      hint: `Remember: ${learnings[0].nextTime}`
    };
  }
}

module.exports = new HybridOrchestrator();