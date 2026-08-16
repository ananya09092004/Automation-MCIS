const { listenForWakeWordLocally } = require('./localWake');
const { recordFollowUpCommand, recordNextCommand } = require('./continuousListen');
const { speak } = require('./tts');
const { getPhrases } = require('./languagePhrases');
const { playBeep } = require('./beep');
const { setMuted } = require('./muteControl');

let isProcessing = false;

const MUTE_PHRASES = ['mute', 'microphone band', 'mic band', 'microphone off', 'mic off', 'chup ho jao', 'sunna band'];

function isMuteCommand(text) {
  const lower = text.toLowerCase();
  return MUTE_PHRASES.some((phrase) => lower.includes(phrase));
}

async function sendCommand(text, config) {
  const res = await fetch(`${config.BACKEND_HTTP_URL}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.AUTH_TOKEN}`
    },
    body: JSON.stringify({ message: text, deviceId: config.DEVICE_ID })
  });
  return res.json();
}

async function speakResult(data, phrases) {
  if (data.type === 'permission_required') {
    await speak(phrases.approvalNeeded(data.message));
  } else if (data.type === 'action' && data.result?.success) {
    await speak(phrases.done);
  } else if (data.type === 'ai_task' && data.output) {
    await speak(data.output.length > 300 ? phrases.ready : data.output);
  } else if (data.type === 'productivity' && data.output) {
    await speak(data.output.summary || phrases.done);
  } else if (data.error) {
    await speak(phrases.error);
  } else {
    await speak(data.message || phrases.done);
  }
}

function startVoice(config) {
  async function handleWake() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      await playBeep();
      let commandText = await recordFollowUpCommand(config.BACKEND_HTTP_URL, config.AUTH_TOKEN);

      if (!commandText) {
        const phrases = getPhrases('');
        await speak(phrases.notUnderstood);
        return;
      }

      let keepGoing = true;
      while (keepGoing) {
        console.log('[MCIS Voice] Command:', commandText);

        // Voice-triggered mute — stop the conversation loop, mute the mic,
        // don't send this as a normal command to the backend.
        if (isMuteCommand(commandText)) {
          setMuted(true);
          await speak('Theek hai, band kar rahi hoon. Wapas chalu karne ke liye "Hey MCIS unmute" boliye.');
          keepGoing = false;
          break;
        }

        const phrases = getPhrases(commandText);
        const data = await sendCommand(commandText, config);
        
        await speakResult(data, phrases);

        const nextText = await recordNextCommand(config.BACKEND_HTTP_URL, config.AUTH_TOKEN, 10000);
        if (nextText) {
          commandText = nextText;
        } else {
          keepGoing = false;
        }
      }
    } catch (err) {
      console.error('[MCIS Voice] Error:', err.message);
      await speak('Kuch error aa gaya');
    } finally {
      isProcessing = false;
    }
  }

  try {
    listenForWakeWordLocally(handleWake);
    console.log('🟢 Listening locally (offline, private) — say "Hey MCIS" followed by your command.');
  } catch (err) {
    console.warn('[MCIS Voice] Voice unavailable on this device:', err.message);
    console.warn('[MCIS Voice] Chat/text commands will still work normally.');
  }
}

module.exports = { startVoice };