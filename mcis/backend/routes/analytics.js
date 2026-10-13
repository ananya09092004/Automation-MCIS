const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============================================
// EXISTING ROUTES (Keep these)
// ============================================

// Get event stats
router.get('/:userId/events', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('events')
      .select('event_type')
      .eq('user_id', userId);

    if (error) throw error;

    const stats = {};
    data.forEach(e => {
      stats[e.event_type] = (stats[e.event_type] || 0) + 1;
    });

    res.json({ success: true, event_stats: stats, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get notification effectiveness
router.get('/:userId/effectiveness', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .select('type, read')
      .eq('user_id', userId);

    if (error) throw error;

    const effectiveness = {};
    let totalRead = 0;
    data.forEach(n => {
      effectiveness[n.type] = (effectiveness[n.type] || 0) + (n.read ? 1 : 0);
      if (n.read) totalRead++;
    });

    res.json({ 
      success: true, 
      effectiveness, 
      readRate: (totalRead / data.length * 100).toFixed(2) + '%'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get activity timeline
router.get('/:userId/timeline', async (req, res) => {
  try {
    const { userId } = req.params;
    const { days = 7 } = req.query;

    const date = new Date();
    date.setDate(date.getDate() - days);

    const { data, error } = await supabase
      .from('events')
      .select('event_type, created_at')
      .eq('user_id', userId)
      .gte('created_at', date.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, timeline: data, period_days: days });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// NEW ROUTES: EXECUTION TRACKING & GROWTH ANALYTICS
// ============================================

// Track execution metrics
router.post('/:userId/track-execution', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      goal,
      mode,
      timeTaken,
      successRate,
      mistakesCount,
      frustrationLevel,
      patternsLearned,
      conceptsDemonstrated
    } = req.body;

    // Insert execution metrics
    const { data, error } = await supabase
      .from('execution_metrics')
      .insert([{
        user_id: userId,
        goal,
        mode,
        time_taken: timeTaken,
        success_rate: successRate,
        mistakes_count: mistakesCount,
        frustration_level: frustrationLevel,
        patterns_learned: patternsLearned,
        concepts_demonstrated: conceptsDemonstrated,
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;

    // Update user analytics
    await updateUserAnalytics(userId);

    res.json({ success: true, message: 'Execution tracked' });
  } catch (err) {
    logger.error(`Error tracking execution: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get growth summary
router.get('/:userId/growth-summary', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get recent executions (last 20)
    const { data: executions, error: execError } = await supabase
      .from('execution_metrics')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (execError) throw execError;

    // Get user analytics
    const { data: analytics, error: analyticsError } = await supabase
      .from('user_analytics')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (analyticsError && analyticsError.code !== 'PGRST116') throw analyticsError;

    // Calculate metrics
    const successRate = executions.length > 0
      ? executions.reduce((acc, e) => acc + e.success_rate, 0) / executions.length
      : 0;

    const avgTime = executions.length > 0
      ? executions.reduce((acc, e) => acc + e.time_taken, 0) / executions.length
      : 0;

    const totalMistakes = executions.reduce((acc, e) => acc + e.mistakes_count, 0);

    const avgFrustration = executions.length > 0
      ? executions.reduce((acc, e) => acc + e.frustration_level, 0) / executions.length
      : 0;

    const patternsLearned = new Set();
    executions.forEach(e => {
      if (e.concepts_demonstrated) {
        e.concepts_demonstrated.forEach(c => patternsLearned.add(c));
      }
    });

    // Determine optimal difficulty
    let optimalDifficulty = 'maintain';
    if (successRate > 0.85) optimalDifficulty = 'increase';
    if (successRate < 0.65) optimalDifficulty = 'decrease';

    // Calculate flow state (0-100)
    const flowState = calculateFlowState(executions);

    // Calculate burnout risk
    const burnoutRisk = calculateBurnoutRisk(executions, avgFrustration);

    // Calculate motivation level
    const motivationLevel = calculateMotivation(executions);

    res.json({
      success: true,
      successMetrics: {
        overallSuccessRate: (successRate * 100).toFixed(1) + '%',
        goalsCompleted: executions.filter(e => e.success_rate === 1).length,
        averageTimePerGoal: avgTime.toFixed(1) + ' min',
        trend: successRate > 0.75 ? 'improving' : successRate > 0.6 ? 'stable' : 'needs work'
      },
      learningMetrics: {
        patternsLearned: patternsLearned.size,
        totalExecutions: executions.length,
        learningVelocity: (patternsLearned.size / Math.max(executions.length, 1)).toFixed(2) + ' per execution'
      },
      flowMetrics: {
        inFlowProbability: flowState.toFixed(0) + '%',
        optimalDifficulty,
        avgTime: avgTime.toFixed(1) + ' min'
      },
      wellbeingMetrics: {
        burnoutRisk,
        motivationLevel: motivationLevel.toFixed(0),
        avgFrustration: avgFrustration.toFixed(1) + '/10'
      },
      progressionMetrics: {
        totalMistakes,
        correctFirstAttempt: executions.filter(e => e.success_rate === 1).length,
        readyForHarder: optimalDifficulty === 'increase'
      }
    });
  } catch (err) {
    logger.error(`Error getting growth summary: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get learning report
router.get('/:userId/learning-report', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: executions, error } = await supabase
      .from('execution_metrics')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;

    // Group by concept
    const conceptStats = {};
    executions.forEach(exec => {
      if (exec.concepts_demonstrated) {
        exec.concepts_demonstrated.forEach(concept => {
          if (!conceptStats[concept]) {
            conceptStats[concept] = {
              timesLearned: 0,
              totalSuccess: 0,
              lastLearned: null
            };
          }
          conceptStats[concept].timesLearned++;
          conceptStats[concept].totalSuccess += exec.success_rate;
          conceptStats[concept].lastLearned = exec.created_at;
        });
      }
    });

    // Calculate success rates
    Object.keys(conceptStats).forEach(concept => {
      const stats = conceptStats[concept];
      stats.successRate = (stats.totalSuccess / stats.timesLearned * 100).toFixed(0) + '%';
    });

    // Identify strengths (>80% success)
    const strengths = Object.entries(conceptStats)
      .filter(([_, stats]) => parseFloat(stats.successRate) > 80)
      .map(([concept, _]) => concept);

    // Identify weaknesses (<70% success)
    const weaknesses = Object.entries(conceptStats)
      .filter(([_, stats]) => parseFloat(stats.successRate) < 70)
      .map(([concept, _]) => concept);

    // Ready to master (practiced 5+ times with good success)
    const readyToMaster = Object.entries(conceptStats)
      .filter(([_, stats]) => stats.timesLearned >= 5 && parseFloat(stats.successRate) > 75)
      .map(([concept, _]) => concept);

    res.json({
      success: true,
      totalPatterns: Object.keys(conceptStats).length,
      concepts: conceptStats,
      strengths,
      weaknesses,
      readyToMaster,
      analysisDate: new Date().toISOString()
    });
  } catch (err) {
    logger.error(`Error getting learning report: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get next perfect challenge
router.get('/:userId/next-perfect-challenge', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user analytics
    const { data: executions, error } = await supabase
      .from('execution_metrics')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    // Analyze user
    const strengths = identifyStrengths(executions);
    const weaknesses = identifyWeaknesses(executions);
    const burnoutRisk = calculateBurnoutRisk(executions, 5);

    let challenge;

    // If burnout risk is high, give easy win
    if (burnoutRisk === 'HIGH') {
      challenge = {
        goal: `Deepen your expertise in ${strengths[0] || 'your strongest skill'}`,
        difficulty: 'low',
        estimatedTime: 10,
        whyThisChallenge: `You've been working hard. Let's do something you're great at 
          to remind yourself how capable you are!`,
        successPrediction: 0.95,
        growthPotential: 'confidence boost',
        rewardMultiplier: 2
      };
    } else if (strengths.length > 0 && weaknesses.length > 0) {
      // Balanced challenge: combine strength + weakness
      challenge = {
        goal: `Combine ${strengths[0]} with ${weaknesses[0]}`,
        difficulty: 'medium',
        estimatedTime: 30,
        whyThisChallenge: `You're strong at ${strengths[0]}. You're working on ${weaknesses[0]}. 
          This combines both - your strength will help you tackle the weakness!`,
        successPrediction: 0.75,
        growthPotential: 'high',
        relatedConcepts: [weaknesses[0], strengths[0]]
      };
    } else {
      // Default
      challenge = {
        goal: 'Master a new pattern',
        difficulty: 'medium',
        estimatedTime: 25,
        successPrediction: 0.70,
        growthPotential: 'medium'
      };
    }

    res.json({
      success: true,
      challenge,
      analysis: {
        strengths,
        weaknesses,
        burnoutRisk
      }
    });
  } catch (err) {
    logger.error(`Error generating next challenge: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function updateUserAnalytics(userId) {
  try {
    const { data: executions } = await supabase
      .from('execution_metrics')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (!executions || executions.length === 0) return;

    const successRate = executions.reduce((acc, e) => acc + e.success_rate, 0) / executions.length;
    const avgFrustration = executions.reduce((acc, e) => acc + e.frustration_level, 0) / executions.length;
    const flowState = calculateFlowState(executions);
    const burnoutRisk = calculateBurnoutRisk(executions, avgFrustration);
    const motivationLevel = calculateMotivation(executions);

    // Upsert user analytics
    await supabase
      .from('user_analytics')
      .upsert([{
        user_id: userId,
        success_rate: successRate,
        avg_frustration: avgFrustration,
        flow_state: flowState,
        burnout_risk: burnoutRisk,
        motivation_level: motivationLevel,
        total_executions: executions.length,
        updated_at: new Date().toISOString()
      }], {
        onConflict: 'user_id'
      });
  } catch (err) {
    logger.error(`Error updating user analytics: ${err.message}`);
  }
}

function calculateFlowState(executions) {
  if (executions.length === 0) return 0;

  const recent = executions.slice(0, 5);
  let flowScore = 0;

  recent.forEach(exec => {
    const lowFrustration = exec.frustration_level < 4;
    const goodSuccess = exec.success_rate > 0.6 && exec.success_rate < 0.95;
    
    if (lowFrustration && goodSuccess) flowScore++;
  });

  return (flowScore / recent.length) * 100;
}

function calculateBurnoutRisk(executions, avgFrustration) {
  if (executions.length === 0) return 'LOW';

  const recent = executions.slice(0, 5);
  let riskFactors = 0;

  // Too many failures
  const failureRate = recent.filter(e => e.success_rate < 0.5).length;
  if (failureRate > 2) riskFactors++;

  // High frustration
  if (avgFrustration > 7) riskFactors++;

  // Too much time
  const tooMuchTime = recent.filter(e => e.time_taken > 120).length;
  if (tooMuchTime > 2) riskFactors++;

  if (riskFactors >= 3) return 'HIGH';
  if (riskFactors >= 2) return 'MEDIUM';
  return 'LOW';
}

function calculateMotivation(executions) {
  if (executions.length === 0) return 0;

  const recent = executions.slice(0, 10);
  const successRate = recent.reduce((acc, e) => acc + e.success_rate, 0) / recent.length;
  const completionBonus = recent.filter(e => e.success_rate === 1).length * 10;

  return (successRate * 100 + completionBonus);
}

function identifyStrengths(executions) {
  const concepts = {};

  executions.forEach(exec => {
    if (exec.concepts_demonstrated) {
      exec.concepts_demonstrated.forEach(concept => {
        if (!concepts[concept]) concepts[concept] = [];
        concepts[concept].push(exec.success_rate);
      });
    }
  });

  return Object.entries(concepts)
    .filter(([_, rates]) => rates.reduce((a, b) => a + b, 0) / rates.length > 0.8)
    .map(([concept, _]) => concept)
    .slice(0, 3);
}

function identifyWeaknesses(executions) {
  const concepts = {};

  executions.forEach(exec => {
    if (exec.concepts_demonstrated) {
      exec.concepts_demonstrated.forEach(concept => {
        if (!concepts[concept]) concepts[concept] = [];
        concepts[concept].push(exec.success_rate);
      });
    }
  });

  return Object.entries(concepts)
    .filter(([_, rates]) => rates.reduce((a, b) => a + b, 0) / rates.length < 0.7)
    .map(([concept, _]) => concept)
    .slice(0, 3);
}

module.exports = router;