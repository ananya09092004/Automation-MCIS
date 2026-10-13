const { recordWavChunk, recordUntilSilence } = require('./audioUtils');

const WAKE_PHRASES = ['hey mcis', 'hey em see is', 'hey mc is', 'hey mcs'];
const CHUNK_DURATION_MS = 3500;

async function transcribeChunk(wavBuffer, backendUrl, deviceToken) {
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  const form = new FormData();
  form.append('audio', blob, 'chunk.wav');

  const res = await fetch(`${backendUrl}/api/voice/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}` },
    body: form
  });

  if (!res.ok) return '';

  const data = await res.json();
  return data.success ? (data.text || '').trim() : '';
}

function extractWakeAndCommand(text) {
  const lower = text.toLowerCase();

  for (const phrase of WAKE_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1) {
      const after = text.slice(idx + phrase.length).replace(/^[\s,.:-]+/, '');
      return { detected: true, command: after };
    }
  }

  return { detected: false, command: '' };
}

function startContinuousListening({ backendUrl, deviceToken, onWake }) {
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        const wav = await recordWavChunk(CHUNK_DURATION_MS);
        const text = await transcribeChunk(wav, backendUrl, deviceToken);

        if (text) {
          const { detected, command } = extractWakeAndCommand(text);
          if (detected) {
            await onWake(command);
          }
        }
      } catch (err) {
        console.error('[MCIS Voice] Listening error:', err && err.message ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  loop();

  return {
    stop: () => { stopped = true; }
  };
}

// First command right after "Hey MCIS" — generous window to start speaking.
async function recordFollowUpCommand(backendUrl, deviceToken) {
  const wav = await recordUntilSilence({ maxDurationMs: 15000, silenceStartTimeoutMs: 6000 });
  if (!wav) return '';
  return transcribeChunk(wav, backendUrl, deviceToken);
}

// Next command in an ongoing conversation, WITHOUT saying "Hey MCIS" again.
// attentiveMs = how long to wait for the user to start speaking before
// giving up and ending the conversation (defaults to 15s).
async function recordNextCommand(backendUrl, deviceToken, attentiveMs = 15000) {
  const wav = await recordUntilSilence({ maxDurationMs: 20000, silenceStartTimeoutMs: attentiveMs });
  if (!wav) return '';
  return transcribeChunk(wav, backendUrl, deviceToken);
}

module.exports = { startContinuousListening, recordFollowUpCommand, recordNextCommand };