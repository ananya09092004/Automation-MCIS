const WebSocket = require('ws');
const { loadOrPair } = require('./pairing');
const { startVoice } = require('./voice');
const { setupMuteToggle } = require('./voice/muteControl');
const appControl = require('./commands/appControl');
const fileControl = require('./commands/fileControl');
const folderControl = require('./commands/folderControl');
const terminalControl = require('./commands/terminalControl');
const vscodeControl = require('./commands/vscodeControl');
const settingsControl = require('./commands/settingsControl');
const downloadsOrganizer = require('./commands/downloadsOrganizer');

let ws;
let config;
let voiceStarted = false;

const COMMAND_HANDLERS = {
  openApp: (payload) => appControl.openApp(payload.appName),
  closeApp: (payload) => appControl.closeApp(payload.appName),
  searchFile: (payload) => fileControl.searchFile(payload.fileName, payload.searchDir),
  openFile: (payload) => fileControl.openFile(payload.filePath),
  createFolder: (payload) => folderControl.createFolder(payload.folderPath),
  renameFolder: (payload) => folderControl.renameFolder(payload.oldPath, payload.newPath),
  deleteFolder: (payload) => folderControl.deleteFolder(payload.folderPath),
  moveFolder: (payload) => folderControl.moveFolder(payload.sourcePath, payload.destPath),
  runCommand: (payload) => terminalControl.runCommand(payload.command, payload.cwd),
  openInVSCode: (payload) => vscodeControl.openInVSCode(payload.targetPath),
  runFileInTerminal: (payload) => vscodeControl.runFileInTerminal(payload.filePath, payload.runner),
  setVolume: (payload) => settingsControl.setVolume(payload.level),
  installSoftware: (payload) => settingsControl.installSoftware(payload.packageName),
  organizeDownloads: (payload) => downloadsOrganizer.organizeDownloads(payload.downloadsPath)
};

function connect() {
  ws = new WebSocket(config.BACKEND_WS_URL, {
    headers: { 'x-device-id': config.DEVICE_ID, 'x-auth-token': config.AUTH_TOKEN }
  });

  ws.on('open', () => {
    console.log(`[MCIS Agent] Connected as ${config.DEVICE_ID}`);
    if (!voiceStarted) {
      voiceStarted = true;
      startVoice({
        BACKEND_HTTP_URL: config.BACKEND_WS_URL.replace(/^ws/, 'http').replace(/\/agent$/, ''),
        DEVICE_ID: config.DEVICE_ID,
        AUTH_TOKEN: config.AUTH_TOKEN
      });
    }
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'command') return;

    const handler = COMMAND_HANDLERS[msg.action];
    if (!handler) return sendResult(msg.commandId, { success: false, error: 'Unknown command' });

    try {
      const result = await handler(msg.payload || {});
      sendResult(msg.commandId, result);
    } catch (err) {
      sendResult(msg.commandId, err);
    }
  });

  ws.on('close', () => {
    console.log('[MCIS Agent] Disconnected, retrying in 5s...');
    setTimeout(connect, config.RECONNECT_INTERVAL_MS);
  });

  ws.on('error', (err) => console.error('[MCIS Agent] Error:', err.message));
}

function sendResult(commandId, result) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'result', commandId, result }));
  }
}

async function main() {
  setupMuteToggle();
  config = await loadOrPair();
  connect();
}

process.on('uncaughtException', (err) => {
  console.error('[MCIS Agent] FATAL uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[MCIS Agent] FATAL unhandledRejection:', err);
});

main();
