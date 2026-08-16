const express = require('express');
const router = express.Router();
const multer = require('multer');
const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const upload = multer({ dest: 'uploads/' });

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file' });
    }

    const wavPath = req.file.path + '.wav';
    fs.renameSync(req.file.path, wavPath);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-large-v3-turbo',
      response_format: 'text'
    });
    fs.unlinkSync(wavPath);
    res.json({ success: true, text: transcription });
  } catch (err) {
    console.error('Transcription error:', err.message);
    const wavPathCleanup = req.file ? req.file.path + '.wav' : null;
    if (wavPathCleanup && fs.existsSync(wavPathCleanup)) {
      fs.unlinkSync(wavPathCleanup);
    } else if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;