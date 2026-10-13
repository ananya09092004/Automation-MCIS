// backend/services/intelligentChallengeGenerator.js

class IntelligentChallengeGenerator {
  async generatePerfectNextChallenge(userId) {
    const userAnalytics = await db.userAnalytics.findOne({ userId });
    const recentExecutions = await db.executionMetrics
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(10);

    // === ANALYZE USER ===
    const userProfile = {
      strengths: this.identifyStrengths(recentExecutions),
      weaknesses: this.identifyWeaknesses(recentExecutions),
      preferredTopics: this.identifyPreferences(recentExecutions),
      learningSpeed: userAnalytics.learningVelocity,
      optimalDifficulty: userAnalytics.optimalDifficulty,
      burnoutRisk: userAnalytics.burnoutRisk
    };

    // === CHECK IF READY ===
    if (userProfile.burnoutRisk === 'HIGH') {
      // Give easy win challenge
      return this.generateEasyWinChallenge(userProfile);
    }

    if (userProfile.learningSpeed === 'fast') {
      // Give harder challenge
      return this.generateHardChallenge(userProfile);
    }

    // === DEFAULT: PERFECT DIFFICULTY ===
    return this.generateBalancedChallenge(userProfile);
  }

  generateBalancedChallenge(userProfile) {
    const {
      strengths,
      weaknesses,
      preferredTopics,
      learningSpeed
    } = userProfile;

    // Get a weakness they haven't practiced recently
    const weaknessToPractice = weaknesses[0];

    // But blend it with a strength for confidence
    const strengthToBlend = strengths[0];

    // Generate challenge
    return {
      goal: `Combine ${strengthToBlend} with ${weaknessToPractice}`,
      difficulty: this.calculateDifficulty(userProfile),
      estimatedTime: this.estimateTime(userProfile),
      
      whyThisChallenge: `
        You're strong at ${strengthToBlend}.
        You're working on ${weaknessToPractice}.
        This combines both - your strength will help you tackle the weakness!
      `,
      
      hints: [
        `Start with the ${strengthToBlend} approach...`,
        `Now apply ${weaknessToPractice} logic...`,
        `Remember: both patterns are equally important`
      ],
      
      successPrediction: 0.75, // 75% chance of success
      growthPotential: 'high', // Will learn a lot
      
      relatedConcepts: [weaknessToPractice, strengthToBlend]
    };
  }

  generateEasyWinChallenge(userProfile) {
    // After struggling, give them an easy win to rebuild confidence
    const strength = userProfile.strengths[0];
    
    return {
      goal: `Deepen your expertise in ${strength}`,
      difficulty: 'low',
      estimatedTime: 10,
      
      whyThisChallenge: `
        You've been working hard. Let's do something you're great at
        to remind yourself how capable you are!
      `,
      
      successPrediction: 0.95,
      growthPotential: 'confidence boost',
      rewardMultiplier: 2 // Double points for morale!
    };
  }

  generateHardChallenge(userProfile) {
    // User is crushing it - make them think!
    return {
      goal: 'Combine 3 different patterns you know',
      difficulty: 'very-high',
      estimatedTime: 60,
      
      whyThisChallenge: `
        You're learning fast. This challenge requires creative thinking.
        No hints. Just you, the problem, and your knowledge.
      `,
      
      successPrediction: 0.60, // Harder = lower success (but they'll learn more)
      growthPotential: 'breakthrough',
      
      description: `Design a system that uses:
        - ${userProfile.strengths[0]}
        - ${userProfile.strengths[1]}
        - A pattern you haven't tried yet`
    };
  }

  calculateDifficulty(userProfile) {
    // 1-10 scale
    if (userProfile.optimalDifficulty === 'increase') return 7;
    if (userProfile.optimalDifficulty === 'decrease') return 4;
    return 5;
  }

  estimateTime(userProfile) {
    // Minutes
    if (userProfile.learningSpeed === 'fast') return 20;
    if (userProfile.learningSpeed === 'slow') return 40;
    return 30;
  }

  identifyStrengths(executions) {
    // Patterns with >80% success rate
    const patterns = {};
    
    executions.forEach(exec => {
      exec.metrics.conceptsDemonstrated?.forEach(concept => {
        patterns[concept] = patterns[concept] || [];
        patterns[concept].push(exec.metrics.successRate);
      });
    });

    return Object.entries(patterns)
      .filter(([_, rates]) => rates.reduce((a, b) => a + b, 0) / rates.length > 0.8)
      .map(([pattern, _]) => pattern)
      .slice(0, 3);
  }

  identifyWeaknesses(executions) {
    // Patterns with <70% success rate
    const patterns = {};
    
    executions.forEach(exec => {
      exec.metrics.conceptsDemonstrated?.forEach(concept => {
        patterns[concept] = patterns[concept] || [];
        patterns[concept].push(exec.metrics.successRate);
      });
    });

    return Object.entries(patterns)
      .filter(([_, rates]) => rates.reduce((a, b) => a + b, 0) / rates.length < 0.7)
      .map(([pattern, _]) => pattern)
      .slice(0, 3);
  }
}

module.exports = new IntelligentChallengeGenerator();