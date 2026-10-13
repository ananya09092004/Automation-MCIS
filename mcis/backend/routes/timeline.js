const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { addMilestone, getGrowthTrajectory, generateTimelineNarrative } = require('../services/lifeTimelineService');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Add milestone manually
router.post('/:userId/milestone', async (req, res) => {
  try {
    const { title, category, learning, skills_gained, impact_level, notes } = req.body;

    if (!title || !category) {
      return res.status(400).json({ success: false, error: 'Title and category required' });
    }

    const result = await addMilestone(req.params.userId, {
      title,
      category: category || 'achievement',
      learning: learning || '',
      skills_gained: skills_gained || [],
      impact_level: impact_level || 3,
      notes: notes || '',
      confidence_change: 0.1
    });

    res.json(result);
  } catch (err) {
    logger.error(`Add milestone error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get growth trajectory
router.get('/:userId/trajectory', async (req, res) => {
  try {
    const result = await getGrowthTrajectory(req.params.userId);
    res.json(result);
  } catch (err) {
    logger.error(`Get trajectory error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get timeline narrative
router.get('/:userId/narrative', async (req, res) => {
  try {
    const narrative = await generateTimelineNarrative(req.params.userId);
    res.json({ success: true, narrative });
  } catch (err) {
    logger.error(`Get narrative error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get full timeline
router.get('/:userId/full', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('life_timeline')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('timeline_date', { ascending: true });

    if (error) throw error;

    res.json({ success: true, timeline: data || [] });
  } catch (err) {
    logger.error(`Get timeline error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Detect milestones from message
router.post('/:userId/detect-milestone', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message required' });
    }

    const prompt = `Analyze this message and detect if it contains a milestone/achievement:

Message: "${message}"

If there's a milestone, extract:
1. Is there a milestone? (yes/no)
2. What is it?
3. Category (skill, project, goal, achievement, failure, learning)
4. Impact level (1-5)
5. What was learned?
6. Skills gained?

Return ONLY JSON (or empty if no milestone):
{
  "has_milestone": true,
  "milestone": "Completed DSA course",
  "category": "achievement",
  "impact_level": 4,
  "learning": "Learned importance of practice",
  "skills_gained": ["DSA", "Problem solving"],
  "confidence_change": 0.2
}

If no milestone, return: {}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content.trim();
    let detected = {};

    try {
      detected = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {}

    // If milestone detected, add it
    if (detected.has_milestone) {
      const result = await addMilestone(req.params.userId, {
        title: detected.milestone,
        category: detected.category,
        learning: detected.learning,
        skills_gained: detected.skills_gained,
        impact_level: detected.impact_level,
        confidence_change: detected.confidence_change
      });

      res.json({
        success: true,
        detected: true,
        milestone: detected,
        saved: result.success
      });
    } else {
      res.json({ success: true, detected: false });
    }
  } catch (err) {
    logger.error(`Detect milestone error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get timeline context for chat
router.get('/:userId/context', async (req, res) => {
  try {
    const narrative = await generateTimelineNarrative(req.params.userId);
    const { data: recentMilestones } = await supabase
      .from('life_timeline')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('timeline_date', { ascending: false })
      .limit(5);

    const context = `YOUR JOURNEY SO FAR:\n${narrative}\n\nRecent milestones:\n${
      recentMilestones?.map(m => `- ${m.milestone} (${m.category})`).join('\n') || 'None yet'
    }`;

    res.json({ success: true, context });
  } catch (err) {
    logger.error(`Get context error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get timeline stats
router.get('/:userId/stats', async (req, res) => {
  try {
    const result = await getGrowthTrajectory(req.params.userId);

    if (!result.success) {
      return res.json({ success: true, stats: { milestones: 0, confidence_gain: 0 } });
    }

    res.json({
      success: true,
      stats: {
        total_milestones: result.total_milestones,
        confidence_gain: (result.total_confidence_gain * 100).toFixed(1) + '%',
        skills_learned: result.skills_acquired.length,
        achievements: result.achievements,
        challenges_overcome: result.failures,
        resilience_ratio: result.resilience_ratio ? (result.resilience_ratio * 100).toFixed(0) + '%' : 'N/A'
      }
    });
  } catch (err) {
    logger.error(`Get stats error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;