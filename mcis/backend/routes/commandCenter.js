const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { getCommandCenter } = require('../services/commandCenterService');
const { extractAndSaveOperatingContext, simulateLite, createAgentPlan } = require('../services/autonomousContextEngine');
const logger = require('../services/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const commandCenter = await getCommandCenter(userId);
    res.json(commandCenter);
  } catch (err) {
    logger.error(`Command center error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: 'Could not prepare command center',
    });
  }
});

router.post('/:userId/extract', async (req, res) => {
  try {
    const { userId } = req.params;
    const { message, response = '', chatId = null } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required',
      });
    }

    const result = await extractAndSaveOperatingContext(userId, message, response, chatId);
    res.json(result);
  } catch (err) {
    logger.error(`Command center extraction error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: 'Could not extract operating context',
    });
  }
});

router.patch('/:userId/items/:itemId', async (req, res) => {
  try {
    const { userId, itemId } = req.params;
    const { action } = req.body;

    const { data: item, error: fetchError } = await supabase
      .from('user_memories')
      .select('*')
      .eq('id', itemId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !item) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    const category = String(item.category || '');
    if (!category.startsWith('pending_')) {
      return res.status(400).json({ success: false, error: 'Item is already reviewed' });
    }

    if (action === 'reject') {
      const { error } = await supabase
        .from('user_memories')
        .delete()
        .eq('id', itemId)
        .eq('user_id', userId);
      if (error) throw error;
      return res.json({ success: true, action: 'rejected' });
    }

    if (action === 'approve') {
      const approvedCategory = category.replace(/^pending_/, '');
      const { data, error } = await supabase
        .from('user_memories')
        .update({ category: approvedCategory })
        .eq('id', itemId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return res.json({ success: true, action: 'approved', item: data });
    }

    return res.status(400).json({ success: false, error: 'action must be approve or reject' });
  } catch (err) {
    logger.error(`Command center item review error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not review item' });
  }
});

router.post('/:userId/simulate-lite', async (req, res) => {
  try {
    const { decision, context = {} } = req.body;
    res.json(simulateLite(decision, context));
  } catch (err) {
    logger.error(`Lite simulation error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not simulate future paths' });
  }
});

router.post('/:userId/agent-plan', async (req, res) => {
  try {
    const { userId } = req.params;
    const { task, context = {} } = req.body;

    if (!task) {
      return res.status(400).json({ success: false, error: 'task is required' });
    }

    const plan = await createAgentPlan(task, { ...context, userId });
    res.json(plan);
  } catch (err) {
    logger.error(`Agent plan error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not create agent plan' });
  }
});

module.exports = router;
