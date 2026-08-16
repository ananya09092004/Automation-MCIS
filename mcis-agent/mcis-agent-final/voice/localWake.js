const vosk = require('vosk-koffi');
const path = require('path');
const { startContinuousRecording } = require('./audioUtils');
const { isMuted, setMuted } = require('./muteControl');

const isPkg = typeof process.pkg !== 'undefined';
const MODEL_PATH = process.env.VOSK_MODEL_PATH ||
  (isPkg
    ? path.join(path.dirname(process.execPath), 'model', 'vosk-model-small-en-us-0.15')
    : path.join(__dirname, '..', 'model', 'vosk-model-small-en-us-0.15'));
const WAKE_PHRASES = ['hey mcis', 'hey em see is', 'hey mc is', 'hey mcs', 'hey system'];
const UNMUTE_PHRASES = ['unmute', 'mic on', 'microphone on', 'listen again', 'start listening'];

let model;
function getModel() {
  if (!model) {
    vosk.setLogLevel(-1);
    model = new vosk.Model(MODEL_PATH);
  }
  return model;
}

function containsAny(text, phrases) {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

function newRecognizer(m) {
  return new vosk.Recognizer({
    model: m,
    // While muted we only need to catch the unmute phrase, but keeping the
    // full grammar (wake + unmute words) avoids swapping recognizers based
    // on mute state, which keeps this simpler and just as accurate.
    grammar: [...WAKE_PHRASES, ...UNMUTE_PHRASES, '[unk]']
  });
}

function listenForWakeWordLocally(onDetected) {
  const m = getModel();
  let recognizer = newRecognizer(m);
  let busy = false;
  let paused = false;
  let proc = null;

  function attachStream() {
    if (paused) return;
    proc = startContinuousRecording();

    proc.stdout.on('data', async (chunk) => {
      if (busy || paused) return;

      try {
        const isFinal = recognizer.acceptWaveform(chunk);
        const raw = isFinal ? recognizer.finalResult() : recognizer.partialResult();
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const text = isFinal ? (result.text || '') : (result.partial || '');

        if (!text) return;

        // Muted: only listen for the unmute phrase, ignore everything else
        // (including the wake word) so no commands get processed while off.
        if (isMuted()) {
          if (containsAny(text, UNMUTE_PHRASES)) {
            try { recognizer.free(); } catch { /* ignore */ }
            recognizer = newRecognizer(m);
            setMuted(false);
          }
          return;
        }

        if (containsAny(text, WAKE_PHRASES)) {
          busy = true;
          console.log('[MCIS Voice] Wake word detected:', text);

          try { recognizer.free(); } catch { /* ignore */ }
          recognizer = newRecognizer(m);

          await pauseListening();
          await onDetected();
          resumeListening();

          busy = false;
        }
      } catch (err) {
        console.error('[MCIS Voice] Local wake-word error:', err.message);
      }
    });

    proc.on('error', (err) => {
      console.error('[MCIS Voice] Recording process error:', err.message);
    });

    proc.on('close', () => {
      if (!paused) {
        console.warn('[MCIS Voice] Mic stream closed, restarting in 1s...');
        setTimeout(attachStream, 1000);
      }
    });
  }

  function pauseListening() {
    return new Promise((resolve) => {
      paused = true;
      if (!proc) return resolve();

      const target = proc;
      proc = null;

      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      target.once('close', done);
      target.once('error', done);
      try { target.kill(); } catch { done(); }

      setTimeout(done, 600);
    });
  }

  function resumeListening() {
    paused = false;
    setTimeout(attachStream, 150);
  }

  attachStream();
  console.log('[MCIS Voice] Continuous local wake-word listening started.');
}

module.exports = { listenForWakeWordLocally };