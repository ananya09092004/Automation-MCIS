const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./services/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const connectedAgents = new Map(); // `${userId}:${deviceId}` -> ws connection
const pendingCommands = new Map(); // commandId -> resolve callback
// Presence (per backend instance): when each device connected and was last heard from.
const presence = new Map(); // `${userId}:${deviceId}` -> { connectedAt, lastSeenAt }
const HEARTBEAT_MS = Number(process.env.AGENT_HEARTBEAT_MS) || 30000;

// Run this SQL once in Supabase to create the device_tokens table:
// create table device_tokens (
//   id uuid primary key default gen_random_uuid(),
//   user_id text not null,
//   device_id text not null,
//   token text not null unique,
//   created_at timestamptz default now(),
//   unique(user_id, device_id)
// );

function attachAgentSocket(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/agent' });

  // Heartbeat: WebSocket ping every HEARTBEAT_MS; a connection that did not answer
  // the previous ping is terminated, so "online" never outlives a dead socket.
  // (Standard ws clients answer pings automatically — no agent change needed.)
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* gone */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, HEARTBEAT_MS);
  if (beat.unref) beat.unref();
  wss.on('close', () => clearInterval(beat));

  wss.on('connection', async (ws, req) => {
    const deviceId = req.headers['x-device-id'];
    const token = req.headers['x-auth-token'];

    if (!deviceId || !token) {
      ws.close(4001, 'Missing device id or token');
      return;
    }

    const { data, error } = await supabase
      .from('device_tokens')
      .select('user_id')
      .eq('device_id', deviceId)
      .eq('token', token)
      .single();

    if (error || !data) {
      logger.warn(`Agent auth failed for device ${deviceId}`);
      ws.close(4001, 'Invalid device token');
      return;
    }

    const userId = data.user_id;
    const key = `${userId}:${deviceId}`;
    connectedAgents.set(key, ws);
    ws.userId = userId;
    ws.deviceId = deviceId;
    ws.isAlive = true;
    const now = new Date().toISOString();
    presence.set(key, { connectedAt: now, lastSeenAt: now });
    const seen = () => { ws.isAlive = true; const p = presence.get(key); if (p && connectedAgents.get(key) === ws) p.lastSeenAt = new Date().toISOString(); };
    ws.on('pong', seen);
    logger.info(`Agent connected: ${key}`);

    ws.on('message', (raw) => {
      seen();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'result' && pendingCommands.has(msg.commandId)) {
        pendingCommands.get(msg.commandId)(msg.result);
        pendingCommands.delete(msg.commandId);
      }
    });

    ws.on('close', () => {
      // A newer connection for the same device may have replaced this one.
      if (connectedAgents.get(key) === ws) {
        connectedAgents.delete(key);
        const p = presence.get(key);
        if (p) presence.set(key, { connectedAt: null, lastSeenAt: p.lastSeenAt });
      }
      logger.info(`Agent disconnected: ${key}`);
    });
  });
}

function sendCommandToAgent(userId, deviceId, action, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const key = `${userId}:${deviceId}`;
    const agentWs = connectedAgents.get(key);

    if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
      return reject({ success: false, error: 'Device not connected' });
    }

    const commandId = `${key}-${Date.now()}`;
    pendingCommands.set(commandId, resolve);

    agentWs.send(JSON.stringify({ type: 'command', commandId, action, payload }));

    setTimeout(() => {
      if (pendingCommands.has(commandId)) {
        pendingCommands.delete(commandId);
        reject({ success: false, error: 'Command timed out' });
      }
    }, timeoutMs);
  });
}

// Final hardening: a revoked device's live connection is closed immediately
// (its token row is deleted, so it cannot reconnect).
function disconnectAgent(userId, deviceId) {
  const key = `${userId}:${deviceId}`;
  const agentWs = connectedAgents.get(key);
  presence.delete(key);
  if (!agentWs) return false;
  connectedAgents.delete(key);
  try { agentWs.close(4003, 'Device revoked'); } catch { /* already closed */ }
  return true;
}

/**
 * Presence of a user's devices on THIS backend instance:
 * { [deviceId]: { online, connectedAt, lastSeenAt } }. Only the caller's own
 * devices (keyed by userId) are ever returned.
 */
function agentPresence(userId) {
  const out = {};
  const prefix = `${userId}:`;
  for (const [key, p] of presence) {
    if (!key.startsWith(prefix)) continue;
    const ws = connectedAgents.get(key);
    out[key.slice(prefix.length)] = { online: !!(ws && ws.readyState === WebSocket.OPEN), connectedAt: ws ? p.connectedAt : null, lastSeenAt: p.lastSeenAt };
  }
  return out;
}

module.exports = { attachAgentSocket, sendCommandToAgent, disconnectAgent, agentPresence };
