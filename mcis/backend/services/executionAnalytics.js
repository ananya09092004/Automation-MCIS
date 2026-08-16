// backend/services/executionAnalytics.js

class ExecutionAnalytics {
  async trackExecution(userId, execution) {
    const {
      goal,
      mode,
      steps,
      learnings,
      timeTaken,
      successRate,
      mistakesCount,
      frustrationLevel
    } = execution;

    // Store detailed execution data
    await db.executionMetrics.insert({
      userId,
      goal,
      mode,
      metrics: {
        // Speed metrics
        timePerStep: steps.map(s => s.duration),
        totalTime: timeTaken,
        timeVsEstimate: timeTaken / estimatedTime,
        
        // Quality metrics
        successRate: successRate,
        mistakesCount: mistakesCount,
        correctFirstAttempt: successRate === 1,
        
        // Learning metrics
        patternsLearned: learnings.length,
        conceptsDemonstrated: learnings.map(l => l.concept),
        
        // Emotional metrics
        frustrationLevel: frustrationLevel, // 1-10
        confidenceGain: learnings.length > 0 ? 1 : 0,
        
        // Behavioral metrics
        pausedCount: execution.pausedCount,
        hintRequests: execution.hintsUsed,
        challengeAttempts: execution.variantAttempts
      },
      createdAt: new Date(),
      mode
    });

    // Analyze in real-time
    await this.updateUserProfile(userId);
  }

  async updateUserProfile(userId) {
    const recentExecutions = await db.executionMetrics
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(20);

    const analytics = {
      // Success patterns
      successRate: this.calculateSuccessRate(recentExecutions),
      averageTimePerGoal: this.calculateAvgTime(recentExecutions),
      mistakesPerGoal: this.calculateAvgMistakes(recentExecutions),
      
      // Learning patterns
      patternsPerDay: this.calculateLearningVelocity(recentExecutions),
      retentionRate: this.calculateRetention(recentExecutions),
      
      // Flow state
      optimalDifficulty: this.calculateOptimalDifficulty(recentExecutions),
      flowStateProbability: this.calculateFlowState(recentExecutions),
      
      // Burnout risk
      burnoutRisk: this.calculateBurnoutRisk(recentExecutions),
      motivationLevel: this.calculateMotivation(recentExecutions),
      
      // Speed
      learningVelocity: this.calculateVelocity(recentExecutions),
      readyForHarder: this.shouldIncreaseGifficulty(recentExecutions)
    };

    await db.userAnalytics.updateOne(
      { userId },
      analytics
    );

    return analytics;
  }

  calculateSuccessRate(executions) {
    const successful = executions.filter(e => e.metrics.successRate === 1).length;
    return successful / executions.length;
  }

  calculateOptimalDifficulty(executions) {
    // Sweet spot: 70-80% success rate
    // If 90%+: increase difficulty
    // If <60%: decrease difficulty
    
    const avgSuccess = this.calculateSuccessRate(executions);
    
    if (avgSuccess > 0.85) return 'increase';
    if (avgSuccess < 0.65) return 'decrease';
    return 'maintain';
  }

  calculateFlowState(executions) {
    // Flow = right difficulty + high engagement + low frustration
    const recent= executions.slice(0, 5);
    
    const flowScore = recentExecutions.reduce((acc, exec) => {
      const difficulty = exec.timeVsEstimate; // 0.8-1.2 is flow
      const inFlow = Math.abs(difficulty - 1) < 0.3;
      const lowFrustration = exec.metrics.frustrationLevel < 4;
      const engaged = exec.metrics.hintRequests < 3;
      
      return acc + (inFlow && lowFrustration && engaged ? 1 : 0);
    }, 0);
    
    return (flowScore / recentExecutions.length) * 100;
  }

  calculateBurnoutRisk(executions) {
    const recentAvg = executions.slice(0, 5);
    
    const risk = {
      tooManyFails: recentAvg.filter(e => e.metrics.successRate < 0.5).length > 2,
      highFrustration: recentAvg.filter(e => e.metrics.frustrationLevel > 7).length > 2,
      tooMuchTime: recentAvg.filter(e => e.metrics.totalTime > 120).length > 2,
      noVariety: recentAvg.map(e => e.goal).length === 1
    };
    
    const riskLevel = Object.values(risk).filter(Boolean).length;
    
    if (riskLevel >= 3) return 'HIGH';
    if (riskLevel >= 2) return 'MEDIUM';
    return 'LOW';
  }

  calculateMotivation(executions) {
    // Streaks, variety, progression
    const streakDays = this.calculateStreak(executions);
    const varietyScore = this.calculateVariety(executions);
    const progressionScore = this.calculateProgression(executions);
    
    return (streakDays * 0.4 + varietyScore * 0.3 + progressionScore * 0.3);
  }
}

module.exports = new ExecutionAnalytics();