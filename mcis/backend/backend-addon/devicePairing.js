const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Run this SQL once in Supabase:
// create table pairing_sessions (
//   session_id text primary key,
//   device_id text not null,
//   approved boolean default false,
//   token text,
//   user_id text,
//   created_at timestamptz default now()
// );

// 1. Agent calls this FIRST (no login needed) to start a pairing session
router.post('/pair/start', async (req, res) => {
  try {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const deviceId = req.body.deviceId || `device-${Date.now()}`;

    const { error } = await supabase
      .from('pairing_sessions')
      .insert({ session_id: sessionId, device_id: deviceId, approved: false });

    if (error) throw error;

    res.json({ success: true, sessionId, deviceId });
  } catch (err) {
    logger.error(`Pairing start error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not start pairing' });
  }
});

// 2. Frontend calls this when the LOGGED-IN user clicks "Approve" on the pairing page
//    (sits behind your existing authenticateFirebaseUser middleware)
router.post('/pair/approve', async (req, res) => {
  try {
    const userId = req.user.uid;
    const { sessionId } = req.body;

    const { data: session, error: fetchErr } = await supabase
      .from('pairing_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    if (fetchErr || !session) {
      return res.status(404).json({ success: false, error: 'Pairing session not found or expired' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    await supabase.from('device_tokens').upsert(
      { user_id: userId, device_id: session.device_id, token },
      { onConflict: 'user_id,device_id' }
    );

    await supabase
      .from('pairing_sessions')
      .update({ approved: true, token, user_id: userId })
      .eq('session_id', sessionId);

    res.json({ success: true, message: 'Device approved' });
  } catch (err) {
    logger.error(`Pairing approve error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not approve device' });
  }
});

// 3. Agent polls this every few seconds until approved=true
router.get('/pair/status', async (req, res) => {
  try {
    const { sessionId } = req.query;

    const { data: session, error } = await supabase
      .from('pairing_sessions')
      .select('approved, token, device_id')
      .eq('session_id', sessionId)
      .single();

    if (error || !session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (!session.approved) {
      return res.json({ approved: false });
    }

    res.json({ approved: true, token: session.token, deviceId: session.device_id });
  } catch (err) {
    logger.error(`Pairing status error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Could not check status' });
  }
});

module.exports = router;
