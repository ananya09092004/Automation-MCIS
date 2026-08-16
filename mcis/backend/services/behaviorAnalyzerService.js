const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Record behavior pattern
async function recordBehaviorPattern(userId, data) {
  try {
    const now = new Date();
    
    const { error } = await supabase
      .from('behavior_patterns')
      .insert([{
        user_id: userId,
        day_of_week: now.toLocaleString('en-US', { weekday: 'long' }),
        hour_of_day: now.getHours(),
        productivity_level: data.productivity_level || 0.5,
        focus_duration: data.focus_duration || 0,
        completion_rate: data.completion_rate || 0.5,
        emotional_state: data.emotional_state || 'neutral',
        created_at: now.toISOString()
      }]);

    if (error) throw error;
    logger.info(`Behavior recorded: ${userId}`);
  } catch (err) {
    logger.error(`Record behavior error: ${err.message}`);
  }
}

// Analyze patterns to find peak productivity
async function getPeakProductivityHours(userId) {
  try {
    const { data, error } = await supabase
      .from('behavior_patterns')
      .select('hour_of_day, productivity_level')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 30*24*60*60*1000).toISOString()); // Last 30 days

    if (error) throw error;

    if (!data || data.length === 0) return null;

    // Find average productivity by hour
    const hourlyAvg = {};
    data.forEach(record => {
      if (!hourlyAvg[record.hour_of_day]) {
        hourlyAvg[record.hour_of_day] = [];
      }
      hourlyAvg[record.hour_of_day].push(record.productivity_level);
    });

    // Calculate averages
    const hourlyScores = {};
    Object.entries(hourlyAvg).forEach(([hour, scores]) => {
      hourlyScores[hour] = scores.reduce((a, b) => a + b) / scores.length;
    });

    // Find peak hours
    const sorted = Object.entries(hourlyScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour, score]) => ({ hour: parseInt(hour), productivity: score }));

    return sorted;
  } catch (err) {
    logger.error(`Get peak hours error: ${err.message}`);
    return null;
  }
}

// Get day-of-week patterns
async function getDayPatterns(userId) {
  try {
    const { data, error } = await supabase
      .from('behavior_patterns')
      .select('day_of_week, productivity_level, completion_rate')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 60*24*60*60*1000).toISOString()); // Last 60 days

    if (error) throw error;

    if (!data || data.length === 0) return null;

    const dayPatterns = {};
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    days.forEach(day => {
      const dayData = data.filter(d => d.day_of_week === day);
      if (dayData.length > 0) {
        const avgProductivity = dayData.reduce((sum, d) => sum + d.productivity_level, 0) / dayData.length;
        const avgCompletion = dayData.reduce((sum, d) => sum + d.completion_rate, 0) / dayData.length;
        dayPatterns[day] = {
          productivity: avgProductivity,
          completion: avgCompletion
        };
      }
    });

    return dayPatterns;
  } catch (err) {
    logger.error(`Get day patterns error: ${err.message}`);
    return null;
  }
}

// Predict user behavior
async function predictUserBehavior(userId) {
  try {
    const peakHours = await getPeakProductivityHours(userId);
    const dayPatterns = await getDayPatterns(userId);

    const prediction = {
      best_hours: peakHours ? peakHours.map(h => h.hour) : null,
      worst_day: dayPatterns ? Object.entries(dayPatterns)
        .sort((a, b) => a[1].productivity - b[1].productivity)[0][0] : null,
      best_day: dayPatterns ? Object.entries(dayPatterns)
        .sort((a, b) => b[1].productivity - a[1].productivity)[0][0] : null,
      recommendations: []
    };

    if (prediction.best_hours) {
      prediction.recommendations.push(`Schedule hard tasks: ${prediction.best_hours.join(', ')}:00`);
    }
    if (prediction.worst_day) {
      prediction.recommendations.push(`Add extra support on ${prediction.worst_day}s`);
    }

    return prediction;
  } catch (err) {
    logger.error(`Predict behavior error: ${err.message}`);
    return null;
  }
}

module.exports = {
  recordBehaviorPattern,
  getPeakProductivityHours,
  getDayPatterns,
  predictUserBehavior
};