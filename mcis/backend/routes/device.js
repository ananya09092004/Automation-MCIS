const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Call this once per laptop (e.g. from MCIS dashboard "Connect this device" button).
// req.user.uid comes from your existing authenticateFirebaseUser middleware.
router.post('/register', async (req, res) => {
  try {
    const userId = req.user.uid;
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'deviceId required' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    const { error } = await supabase
      .from('device_tokens')
      .upsert({ user_id: userId, device_id: deviceId, token }, { onConflict: 'user_id,device_id' });

    if (error) throw error;

    res.json({ success: true, deviceId, token });
  } catch (err) {
    logger.error(`Device registration error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not register device' });
  }
});

router.get('/list', async (req, res) => {
  try {
    const userId = req.user.uid;
    const { data, error } = await supabase
      .from('device_tokens')
      .select('device_id, created_at')
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ success: true, devices: data });
  } catch (err) {
    logger.error(`Device list error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not list devices' });
  }
});

// Final hardening: revoke a paired device (the caller's own devices only).
// Its token stops working at once, stored pairing copies are cleared and a
// live agent connection is closed. Another user's device id → 404.
router.delete('/:deviceId', async (req, res) => {
  try {
    const userId = req.user && req.user.uid;
    const { deviceId } = req.params;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 200) {
      return res.status(400).json({ success: false, error: 'deviceId is invalid' });
    }
    const { data, error } = await supabase
      .from('device_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .select('device_id');
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ success: false, error: 'Device not found' });

    await supabase.from('pairing_sessions').update({ token: null }).eq('device_id', deviceId).eq('user_id', userId);
    const disconnected = require('../agentSocket').disconnectAgent(userId, deviceId);
    try {
      Promise.resolve(require('../security-engine/auditLog').appendAuditLog(userId, 'device_revoked', { deviceId, disconnected }, { success: true })).catch(() => {});
    } catch { /* audit is best-effort */ }
    res.json({ success: true, revoked: deviceId, disconnected });
  } catch (err) {
    logger.error(`Device revoke error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not revoke device' });
  }
});

module.exports = router;
