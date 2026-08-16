const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

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

function buildSoxArgs(outputPath, durationSeconds) {
  const platform = os.platform();
  const common = ['-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', outputPath, 'trim', '0', String(durationSeconds), 'gain', '4'];

  if (platform === 'win32') {
    return ['-t', 'waveaudio', '-d', ...common];
  }
  if (platform === 'darwin') {
    return ['-t', 'coreaudio', 'default', ...common];
  }
  return ['-t', 'alsa', 'default', ...common];
}

function recordWavChunk(durationMs) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `mcis-voice-${crypto.randomBytes(6).toString('hex')}.wav`);
    const durationSeconds = (durationMs / 1000).toFixed(1);
    const args = buildSoxArgs(tempFile, durationSeconds);

    let stderrOutput = '';
    let settled = false;
    const proc = spawn(SOX_PATH, args, { shell: true });
    proc.stderr.on('data', (c) => { stderrOutput += c.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start sox (path: ${SOX_PATH}): ${err.message}`));
    });

    proc.on('close', () => {
      if (settled) return;
      settled = true;

      setTimeout(() => {
        try {
          const data = fs.readFileSync(tempFile);
          fs.unlink(tempFile, () => {});
          if (data.length < 100) {
            return reject(new Error(`Recording produced almost no data (${data.length} bytes). stderr: ${stderrOutput.slice(0, 300)}`));
          }
          resolve(data);
        } catch (err) {
          reject(new Error(`Could not read recorded audio: ${err.message}. stderr: ${stderrOutput.slice(0, 300)}`));
        }
      }, 200);
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch { /* ignore */ }
        reject(new Error('Recording timed out.'));
      }
    }, durationMs + 3000);
  });
}

function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

function computeRms(pcmBuffer) {
  if (pcmBuffer.length < 2) return 0;
  let sumSquares = 0;
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function startContinuousRecording(gain) {
  const platform = os.platform();
  const gainVal = gain || process.env.MCIS_MIC_GAIN || '3';
  const base = ['-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-', 'gain', gainVal];
  let args;
  if (platform === 'win32') args = ['-t', 'waveaudio', '-d', ...base];
  else if (platform === 'darwin') args = ['-t', 'coreaudio', 'default', ...base];
  else args = ['-t', 'alsa', 'default', ...base];

  const proc = spawn(SOX_PATH, args, { shell: true });
  return proc;
}

// silenceStartTimeoutMs: if given and the user hasn't started speaking
// within this window, stop early instead of waiting the full maxDurationMs.
// Used for conversational follow-up turns — give up quickly if silent.
// Returns null (not an error) when nothing was said.
function recordUntilSilence({ maxDurationMs = 15000, silenceStartTimeoutMs = null, gain = '6' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = startContinuousRecording(gain);
    const WINDOW_BYTES = 16000 * 2 * 0.5;
    const SILENCE_THRESHOLD = Number(process.env.MCIS_VAD_THRESHOLD || 250);
    const SILENT_WINDOWS_TO_STOP = 3;

    const allChunks = [];
    let windowBuf = Buffer.alloc(0);
    let hasSpoken = false;
    let silentStreak = 0;
    let settled = false;

    console.log('[MCIS Voice] Listening...');

    const maxTimer = setTimeout(() => finish(), maxDurationMs);

    let startTimer = null;
    if (silenceStartTimeoutMs) {
      startTimer = setTimeout(() => {
        if (!hasSpoken) finish();
      }, silenceStartTimeoutMs);
    }

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      if (startTimer) clearTimeout(startTimer);
      try { proc.kill(); } catch { /* ignore */ }
      const full = Buffer.concat(allChunks);
      if (full.length < 100 || !hasSpoken) {
        return resolve(null);
      }
      resolve(pcmToWav(full));
    }

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      allChunks.push(chunk);
      windowBuf = Buffer.concat([windowBuf, chunk]);

      while (windowBuf.length >= WINDOW_BYTES) {
        const window = windowBuf.slice(0, WINDOW_BYTES);
        windowBuf = windowBuf.slice(WINDOW_BYTES);
        const rms = computeRms(window);

        if (rms > SILENCE_THRESHOLD) {
          if (!hasSpoken) {
            console.log('[MCIS Voice] Speech detected, RMS:', Math.round(rms));
            if (startTimer) clearTimeout(startTimer);
          }
          hasSpoken = true;
          silentStreak = 0;
        } else if (hasSpoken) {
          silentStreak++;
          if (silentStreak >= SILENT_WINDOWS_TO_STOP) {
            console.log('[MCIS Voice] Silence detected, stopping capture.');
            finish();
            return;
          }
        }
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      if (startTimer) clearTimeout(startTimer);
      reject(new Error(`Could not start sox (path: ${SOX_PATH}): ${err.message}`));
    });
  });
}

module.exports = { recordWavChunk, recordUntilSilence, startContinuousRecording };