const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Get all notifications for user
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    logger.info(`Notifications fetched for ${userId}: ${data?.length || 0}`);
    res.json({ success: true, notifications: data || [] });
  } catch (err) {
    logger.error(`Get notifications error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark as read
router.patch('/:notifId/read', async (req, res) => {
  try {
    const { notifId } = req.params;

    // Layer 2 security fix: notifications are a per-user inbox — only the
    // owner may change one (previously any id worked).
    let q = supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', notifId);
    if (req.user && req.user.uid) q = q.eq('user_id', req.user.uid);
    const { data: changed, error } = await q.select('id');

    if (error) throw error;
    if (req.user && req.user.uid && !(changed && changed.length)) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    logger.info(`Notification ${notifId} marked as read`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Mark read error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete notification
router.delete('/:notifId', async (req, res) => {
  try {
    const { notifId } = req.params;

    let q = supabase
      .from('notifications')
      .delete()
      .eq('id', notifId);
    if (req.user && req.user.uid) q = q.eq('user_id', req.user.uid);
    const { data: removed, error } = await q.select('id');

    if (error) throw error;
    if (req.user && req.user.uid && !(removed && removed.length)) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    logger.info(`Notification ${notifId} deleted`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Delete notification error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;