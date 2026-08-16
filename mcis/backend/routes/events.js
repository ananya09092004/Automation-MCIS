const express = require('express');
const router = express.Router();
const { createEvent, getUserEvents, processEvents, processEventTriggers } = require('../services/eventService');
const { getTriggerHistory } = require('../services/eventTriggerService');
const logger = require('../services/logger');

// Get user events
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;

    const events = await getUserEvents(userId, parseInt(limit));
    res.json({ success: true, events });
  } catch (err) {
    logger.error(`Get events error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create event manually
router.post('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { event_type, data } = req.body;

    if (!event_type) {
      return res.status(400).json({ success: false, error: 'event_type required' });
    }

    const result = await createEvent(userId, event_type, data);
    res.json(result);
  } catch (err) {
    logger.error(`Create event error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Process events and get triggers
// Process events and execute triggers
router.post('/:userId/process', async (req, res) => {
  try {
    const { userId } = req.params;
    const { events } = req.body;

    if (!events || events.length === 0) {
      return res.json({ success: true, triggers: [] });
    }

    // Get smart responses
    const triggers = await processEvents(userId, events);
    
    // Execute triggers (create notifications)
    const executedTriggers = await processEventTriggers(userId, events);
    
    res.json({ success: true, triggers, executed: executedTriggers });
  } catch (err) {
    logger.error(`Process events error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});
// Get trigger history
router.get('/:userId/triggers', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;

    const history = await getTriggerHistory(userId, parseInt(limit));
    res.json({ success: true, triggers: history });
  } catch (err) {
    logger.error(`Get trigger history error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});
module.exports = router;