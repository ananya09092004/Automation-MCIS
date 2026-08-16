const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const logger = require('../services/logger');

// Phase 2.4C imports
const { breakDownGoal, createGoalWithBreakdown, getGoalBreakdown, updateGoalProgress } = require('../services/goalBreakdownService');
const { generateDailyPlan, saveDailyPlan, getTodayPlan, updateTaskCompletion } = require('../services/dailyPlanService');
const { conductWeeklyReview, adaptPlan } = require('../services/adaptationEngineService');
const { getUserDeepProfile } = require('../services/userDeepProfileService');
const { predictUserBehavior } = require('../services/behaviorAnalyzerService');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== EXISTING ENDPOINTS =====

// Sab goals load karo
router.get('/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, goals: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Naya goal banao (Legacy)
router.post('/', async (req, res) => {
  try {
    const { userId, title, description, category, targetDate } = req.body;

    const { data, error } = await supabase
      .from('goals')
      .insert([{
        user_id: userId,
        title,
        description: description || '',
        category: category || 'general',
        target_date: targetDate || null,
        progress: 0,
        status: 'active'
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, goal: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Progress update karo
router.patch('/:goalId/progress', async (req, res) => {
  try {
    const { progress, note, userId } = req.body;
    const { goalId } = req.params;

    // Goal update karo
    const { data, error } = await supabase
      .from('goals')
      .update({
        progress: Math.min(100, Math.max(0, progress)),
        status: progress >= 100 ? 'completed' : 'active',
        updated_at: new Date().toISOString()
      })
      .eq('id', goalId)
      .select()
      .single();

    if (error) throw error;

    // Update history save karo
    await supabase.from('goal_updates').insert([{
      goal_id: goalId,
      user_id: userId,
      note: note || '',
      progress
    }]);

    // Auto-adapt plan if using new system
    if (progress < 50 || progress > 90) {
      try {
        await adaptPlan(userId, goalId, progress);
        logger.info(`Plan auto-adapted for progress: ${progress}%`);
      } catch (adaptErr) {
        logger.error(`Auto-adapt error: ${adaptErr.message}`);
      }
    }

    res.json({ success: true, goal: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Goal delete karo
router.delete('/:goalId', async (req, res) => {
  try {
    await supabase.from('goals').delete().eq('id', req.params.goalId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI weekly report
router.get('/:userId/report/weekly', async (req, res) => {
  try {
    const { data: goals } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', req.params.userId)
      .eq('status', 'active');

    if (!goals || goals.length === 0) {
      return res.json({ 
        success: true, 
        report: 'No active goals found. Add some goals to get your weekly report!' 
      });
    }

    const goalsText = goals.map(g => {
      const daysLeft = g.target_date
        ? Math.ceil((new Date(g.target_date) - new Date()) / (1000 * 60 * 60 * 24))
        : null;
      return `- ${g.title}: ${g.progress}% complete${daysLeft ? `, ${daysLeft} days left` : ''}`;
    }).join('\n');

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are MCIS â€” a personal AI that genuinely cares about the user's progress. 
Generate a motivating, personalized weekly report. Be specific, encouraging, and give actionable advice.
Keep it concise but impactful. Use the user's actual goal data.`
        },
        {
          role: 'user',
          content: `My current goals:\n${goalsText}\n\nGenerate my weekly progress report with insights and next steps.`
        }
      ],
      model: 'qwen/qwen3.6-27b',
      max_tokens: 500
    });

    let report = completion.choices[0].message.content || '';
    // Reasoning models (e.g. qwen) emit their internal chain-of-thought wrapped
    // in <think>...</think> — strip it so only the final report reaches the user.
    report = report.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Conversation se goals detect karo
router.post('/detect', async (req, res) => {
  try {
    const { userId, message } = req.body;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Extract goals from user message. Return ONLY valid JSON array or empty array [].
Format: [{"title": "goal title", "category": "career/health/learning/personal/finance", "description": "brief description"}]
Only extract if message clearly states a goal/target/aim. Otherwise return [].`
        },
        { role: 'user', content: message }
      ],
      model: 'qwen/qwen3.6-27b',
      max_tokens: 200,
      temperature: 0.1
    });

    let detected = [];
    try {
      const text = completion.choices[0].message.content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json|```/g, '')
        .trim();
      detected = JSON.parse(text);
    } catch {}

    // Detected goals save karo
    for (const goal of detected) {
      await supabase.from('goals').insert([{
        user_id: userId,
        title: goal.title,
        description: goal.description || '',
        category: goal.category || 'general',
        progress: 0,
        status: 'active'
      }]);
    }

    res.json({ success: true, detected });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== PHASE 2.4C ENDPOINTS (NEW) =====

// Create goal with breakdown (Smart Goal Creation)
router.post('/:userId/create-with-breakdown', async (req, res) => {
  try {
    const { userId } = req.params;
    const { goalTitle, goalDescription, targetDate } = req.body;

    if (!goalTitle) {
      return res.status(400).json({ success: false, error: 'Goal title required' });
    }

    const result = await createGoalWithBreakdown(
      userId,
      goalTitle,
      goalDescription || '',
      targetDate || new Date(Date.now() + 180*24*60*60*1000).toISOString().split('T')[0]
    );

    res.json(result);
  } catch (err) {
    logger.error(`Create breakdown error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get goal breakdown with phases
router.get('/:userId/breakdown/:goalId', async (req, res) => {
  try {
    const result = await getGoalBreakdown(req.params.userId, req.params.goalId);
    res.json(result);
  } catch (err) {
    logger.error(`Get breakdown error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate optimized daily plan
router.post('/:userId/generate-daily-plan', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user profile for personalization
    const userProfile = await getUserDeepProfile(userId);
    const userBehavior = await predictUserBehavior(userId);

    // Get active goals
    const { data: activeGoals } = await supabase
      .from('goal_breakdowns')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    // Generate plan
    const planResult = await generateDailyPlan(
      userId,
      userProfile || {},
      activeGoals || [],
      userBehavior || {}
    );

    if (planResult.success) {
      const saved = await saveDailyPlan(userId, planResult.plan);
      res.json(saved);
    } else {
      res.json(planResult);
    }
  } catch (err) {
    logger.error(`Generate plan error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get today's execution plan
router.get('/:userId/today-plan', async (req, res) => {
  try {
    const result = await getTodayPlan(req.params.userId);
    
    if (!result.plan) {
      // Generate if doesn't exist
      const generateResult = await generateDailyPlan(req.params.userId, {}, [], {});
      if (generateResult.success) {
        const saved = await saveDailyPlan(req.params.userId, generateResult.plan);
        res.json(saved);
      } else {
        res.json(result);
      }
    } else {
      res.json(result);
    }
  } catch (err) {
    logger.error(`Get today plan error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update task completion for today
router.patch('/:userId/today-plan/complete-task', async (req, res) => {
  try {
    const { planId, completedCount } = req.body;

    if (!planId) {
      return res.status(400).json({ success: false, error: 'Plan ID required' });
    }

    const result = await updateTaskCompletion(planId, completedCount);
    res.json(result);
  } catch (err) {
    logger.error(`Update task error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Conduct weekly review & get insights
router.post('/:userId/review-weekly/:goalId', async (req, res) => {
  try {
    const result = await conductWeeklyReview(req.params.userId, req.params.goalId);
    res.json(result);
  } catch (err) {
    logger.error(`Weekly review error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Auto-adapt plan based on performance
router.post('/:userId/adapt/:goalId', async (req, res) => {
  try {
    const { performance } = req.body;

    if (performance === undefined) {
      return res.status(400).json({ success: false, error: 'Performance metric required' });
    }

    const result = await adaptPlan(req.params.userId, req.params.goalId, performance);
    res.json(result);
  } catch (err) {
    logger.error(`Adapt plan error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all goals with breakdown info
router.get('/:userId/all-with-breakdown', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: goals, error } = await supabase
      .from('goal_breakdowns')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, goals: goals || [] });
  } catch (err) {
    logger.error(`Get all breakdown goals error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get goal reviews (weekly insights)
router.get('/:userId/reviews/:goalId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('goal_reviews')
      .select('*')
      .eq('user_id', req.params.userId)
      .eq('goal_id', req.params.goalId)
      .order('review_date', { ascending: false })
      .limit(10);

    if (error) throw error;

    res.json({ success: true, reviews: data || [] });
  } catch (err) {
    logger.error(`Get reviews error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;