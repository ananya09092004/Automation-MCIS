const readline = require('readline');

let muted = false;

function isMuted() {
  return muted;
}

function setMuted(value) {
  muted = value;
  console.log(muted
    ? '🔇 Microphone MUTED — nothing is being recorded. Say "Hey MCIS unmute" or press M to resume.'
    : '🎙️ Microphone active again — say "Hey MCIS" to give a command.');
}

function toggleMuted() {
  setMuted(!muted);
}

function setupMuteToggle() {
  if (!process.stdin.isTTY) {
    console.log('[MCIS Voice] Mute toggle unavailable (no interactive terminal).');
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  console.log('[MCIS Voice] Press "M" to mute/unmute the microphone at any time.');

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit();
    }

    if (key.name === 'm') {
      toggleMuted();
    }
  });
}

module.exports = { isMuted, setMuted, toggleMuted, setupMuteToggle };