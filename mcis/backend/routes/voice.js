const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// P1.4 -- /api/voice/transcribe hardening.
//
// Previously this endpoint was: publicly reachable with no authentication
// (listed in middleware/auth.js's publicApiPaths), had no file size cap,
// accepted any file as "audio" with no content-type check, and had no
// rate limit or timeout on the upstream Groq call. Any caller who could
// reach the backend could upload arbitrary-sized files repeatedly and
// consume Groq API quota/cost on this server's credentials, or tie up a
// request indefinitely if the upstream call hung.
//
// Fixes, each explained at its point of use below:
//   1. Authentication is now required (removed from publicApiPaths in
//      middleware/auth.js) -- both real callers (the web frontend via
//      Firebase ID token, the desktop agent via its paired device token)
//      already send an Authorization header, so this is not a breaking
//      change for legitimate use.
//   2. A strict file size cap (multer `limits.fileSize`).
//   3. A content-type allowlist (multer `fileFilter`) -- only audio/* is
//      accepted, so arbitrary file types can't be pushed through this
//      upload path.
//   4. A per-caller rate limit, keyed by authenticated uid when present
//      (falls back to IP only for the narrow, explicitly-logged dev-mode
//      case where auth is disabled).
//   5. A bounded timeout around the Groq call so a stuck upstream request
//      can't hold the worker/connection open forever.
//   6. Raw audio bytes are never logged -- only the error message (this
//      was already true before this change; preserved here).

const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // 15MB -- generous for a voice command/chunk, not for abuse.
const TRANSCRIBE_TIMEOUT_MS = 20000;

const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: MAX_AUDIO_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (typeof file.mimetype === 'string' && file.mimetype.startsWith('audio/')) {
      return cb(null, true);
    }
    return cb(new Error('Only audio files are accepted.'));
  },
});

const transcribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { success: false, error: 'Too many transcription requests. Please wait a minute.' },
});

router.use(transcribeLimiter);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanupUpload(req) {
  if (!req.file) return;
  const wavPathCleanup = req.file.path + '.wav';
  try {
    if (fs.existsSync(wavPathCleanup)) fs.unlinkSync(wavPathCleanup);
    else if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  } catch (_cleanupErr) {
    // Best-effort cleanup only -- never let a cleanup failure mask the
    // real error or crash the request.
  }
}

router.post('/transcribe', (req, res, next) => {
  upload.single('audio')(req, res, (err) => {
    if (err) {
      // multer errors (file too large, filter rejection, etc.) land here,
      // before any file is persisted beyond multer's own temp handling.
      return res.status(400).json({ success: false, error: 'Invalid audio upload: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file' });
    }

    const wavPath = req.file.path + '.wav';
    fs.renameSync(req.file.path, wavPath);

    const audioStream = fs.createReadStream(wavPath);
    // If the request times out (below) or the upstream call otherwise
    // never consumes this stream, the file gets cleaned up by the catch
    // block while this stream may still be opening/reading -- without a
    // listener here, that surfaces as an unhandled 'error' event on the
    // stream and crashes the whole process, not just this request.
    audioStream.on('error', () => {});

    const transcription = await withTimeout(
      groq.audio.transcriptions.create({
        file: audioStream,
        model: 'whisper-large-v3-turbo',
        response_format: 'text',
      }),
      TRANSCRIBE_TIMEOUT_MS,
      'Transcription',
    );

    fs.unlinkSync(wavPath);
    res.json({ success: true, text: transcription });
  } catch (err) {
    // Deliberately logs only the error message -- never the audio buffer,
    // file path contents, or request body.
    console.error('Transcription error:', err.message);
    cleanupUpload(req);
    const status = /timed out/i.test(err.message) ? 504 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;
