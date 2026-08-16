const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Add milestone to timeline
async function addMilestone(userId, milestone) {
  try {
    const { data, error } = await supabase
      .from('life_timeline')
      .insert([{
        user_id: userId,
        timeline_date: new Date().toISOString().split('T')[0],
        milestone: milestone.title,
        category: milestone.category, // skill, project, goal, achievement, failure
        impact_level: milestone.impact_level || 3,
        learning: milestone.learning,
        skills_gained: milestone.skills_gained || [],
        confidence_change: milestone.confidence_change || 0.1,
        notes: milestone.notes,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    logger.info(`Milestone added: ${milestone.title}`);
    return { success: true, milestone: data[0] };
  } catch (err) {
    logger.error(`Add milestone error: ${err.message}`);
    return { success: false };
  }
}

// Get user's growth trajectory
async function getGrowthTrajectory(userId) {
  try {
    const { data, error } = await supabase
      .from('life_timeline')
      .select('*')
      .eq('user_id', userId)
      .order('timeline_date', { ascending: true });

    if (error) throw error;

    // Calculate growth metrics
    let totalConfidenceGain = 0;
    let skillsLearned = new Set();
    let achievementCount = 0;
    let failureCount = 0;
    const timeline = [];

    data.forEach(record => {
      totalConfidenceGain += record.confidence_change || 0;
      record.skills_gained?.forEach(skill => skillsLearned.add(skill));
      if (record.category === 'achievement') achievementCount++;
      if (record.category === 'failure') failureCount++;

      timeline.push({
        date: record.timeline_date,
        milestone: record.milestone,
        category: record.category,
        impact: record.impact_level
      });
    });

    return {
      success: true,
      total_milestones: data.length,
      total_confidence_gain: totalConfidenceGain,
      skills_acquired: Array.from(skillsLearned),
      achievements: achievementCount,
      failures: failureCount,
      resilience_ratio: failureCount > 0 ? achievementCount / failureCount : null,
      timeline
    };
  } catch (err) {
    logger.error(`Get trajectory error: ${err.message}`);
    return { success: false };
  }
}

// Generate timeline narrative
async function generateTimelineNarrative(userId) {
  try {
    const trajectory = await getGrowthTrajectory(userId);
    
    if (!trajectory.success) return '';

    const narrative = `Your Growth Timeline:
    
Started with: Beginner
Current: Intermediate+
Confidence Growth: +${(trajectory.total_confidence_gain * 100).toFixed(0)}%

Milestones Completed: ${trajectory.total_milestones}
Skills Acquired: ${trajectory.skills_acquired.length}
Achievements: ${trajectory.achievements}
Challenges Overcome: ${trajectory.failures}

Resilience Score: ${trajectory.resilience_ratio ? (trajectory.resilience_ratio * 100).toFixed(0) + '%' : 'N/A'}

Key Insight: You've grown significantly. You learn from failures.
Next Phase: Build on your momentum.`;

    return narrative;
  } catch (err) {
    logger.error(`Generate narrative error: ${err.message}`);
    return '';
  }
}

module.exports = {
  addMilestone,
  getGrowthTrajectory,
  generateTimelineNarrative
};