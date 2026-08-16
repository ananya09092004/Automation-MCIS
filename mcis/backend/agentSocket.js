const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./services/logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const connectedAgents = new Map(); // `${userId}:${deviceId}` -> ws connection
const pendingCommands = new Map(); // commandId -> resolve callback

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
    logger.info(`Agent connected: ${key}`);

    ws.on('message', (raw) => {
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
      connectedAgents.delete(key);
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

module.exports = { attachAgentSocket, sendCommandToAgent };
