const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.mcis-agent-config.json');
const BACKEND_HTTP_URL = process.env.MCIS_BACKEND_HTTP_URL || 'http://localhost:5051';
const FRONTEND_URL = process.env.MCIS_FRONTEND_URL || 'http://localhost:3000';
function openBrowser(url) {
  const platform = os.platform();
  const cmd = platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function firstRunPairing() {
  console.log('🔗 First time setup — opening your browser to connect this laptop to MCIS...');

  const deviceId = `${os.hostname()}-${os.platform()}`;
  const startRes = await httpPost(`${BACKEND_HTTP_URL}/api/device/pair/start`, { deviceId });

  if (!startRes.success) {
    console.error('Could not start pairing. Check your internet connection and try again.');
    process.exit(1);
  }

  const { sessionId } = startRes;
  const pairingUrl = `${FRONTEND_URL}/pair?session=${sessionId}`;

  openBrowser(pairingUrl);
  console.log(`If the browser didn't open, go to: ${pairingUrl}`);
  console.log('Waiting for you to click "Approve" on the MCIS website...');

  // poll every 2 seconds, for up to 5 minutes
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await httpGet(`${BACKEND_HTTP_URL}/api/device/pair/status?sessionId=${sessionId}`);

    if (status.approved) {
      const config = {
        backendUrl: BACKEND_HTTP_URL.replace(/^http/, 'ws') + '/agent',
        deviceId: status.deviceId,
        token: status.token
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('✅ Device connected! Starting MCIS Agent...');
      return config;
    }
  }

  console.error('Pairing timed out. Please restart the agent and try again.');
  process.exit(1);
}

async function loadOrPair() {
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      BACKEND_WS_URL: config.backendUrl,
      DEVICE_ID: config.deviceId,
      AUTH_TOKEN: config.token,
      RECONNECT_INTERVAL_MS: 5000
    };
  }

  const config = await firstRunPairing();
  return {
    BACKEND_WS_URL: config.backendUrl,
    DEVICE_ID: config.deviceId,
    AUTH_TOKEN: config.token,
    RECONNECT_INTERVAL_MS: 5000
  };
}

module.exports = { loadOrPair };
