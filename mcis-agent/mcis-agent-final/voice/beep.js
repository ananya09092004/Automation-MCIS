const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function resolveSoxPath() {
  const platform = os.platform();
  const exeDir = path.dirname(process.execPath);
  const devDir = __dirname;
  const candidates = platform === 'win32'
    ? [
        path.join(exeDir, 'bin', 'sox', 'sox.exe'),
        path.join(devDir, '..', 'bin', 'sox', 'sox.exe')
      ]
    : [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'sox';
}

const SOX_PATH = resolveSoxPath();

// Short pure-tone cue (not speech) — played through speakers so the user
// knows recording started, but unlike a spoken TTS phrase it won't bleed
// into the mic and corrupt the following command's transcription.
function playBeep() {
  return new Promise((resolve) => {
    const platform = os.platform();
    const outArgs = platform === 'win32' ? ['-t', 'waveaudio', '-d']
      : platform === 'darwin' ? ['-t', 'coreaudio', 'default']
      : ['-t', 'alsa', 'default'];

    const args = ['-n', ...outArgs, 'synth', '0.15', 'sine', '880', 'vol', '0.3'];
    let settled = false;
    const proc = spawn(SOX_PATH, args, { shell: true });

    proc.on('close', () => { if (!settled) { settled = true; resolve(); } });
    proc.on('error', () => { if (!settled) { settled = true; resolve(); } }); // never block on beep failure

    setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 800); // safety net
  });
}

module.exports = { playBeep };