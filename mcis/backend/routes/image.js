// backend/routes/image.js

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { uploadImage, cloudinary } = require('../services/cloudinary');
const { smartSaveMemory } = require('../services/memoryManager');
const { saveConversation } = require('../services/database');
const { verifyAndFix } = require('../services/codeVerificationService');
const logger = require('../services/logger');

// ✅ FIX: llama-3.2-90b-vision-preview was decommissioned by Groq.
// Now with a FALLBACK chain — if the primary vision model fails/rate-limits,
// automatically retries with the next one instead of failing the whole request.
const VISION_MODEL_CHAIN = [
  'meta-llama/llama-4-scout-17b-16e-instruct',  // primary — vision-focused, currently active
  'qwen/qwen3.6-27b',                            // fallback — also supports vision (text+image)
];

// Some models (Qwen3.6) are reasoning models and need extra params so the final
// answer lands directly in message.content, same shape as a normal chat model.
function getVisionExtraParams(model) {
  if (model === 'qwen/qwen3.6-27b') {
    return { reasoning_effort: 'none' };
  }
  return {};
}

// Tries each model in the chain in order. Only moves to the next model on a
// genuine failure (rate limit, decommission, timeout) — not on content issues.
async function callVisionModelWithFallback(contentParts, maxTokens) {
  const errors = [];
  for (const model of VISION_MODEL_CHAIN) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: 'user', content: contentParts }],
        max_tokens: maxTokens,
        ...getVisionExtraParams(model),
      });
      if (VISION_MODEL_CHAIN.indexOf(model) > 0) {
        logger.info(`[IMAGE] Fallback vision model used: ${model}`);
      }
      return completion.choices[0].message.content;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      logger.warn(`[IMAGE] Vision model ${model} failed — trying next...`);
    }
  }
  throw new Error(`All vision models failed. Errors: ${errors.join(' | ')}`);
}

// ✅ No more keyword guessing. The model itself looks at the image(s) and decides
// what kind of content it is, then responds appropriately — like Claude does.
function buildAdaptivePrompt(userInstruction, fileCount) {
  const multiImageNote = fileCount > 1
    ? `You have been given ${fileCount} images. If they are screenshots of the SAME coding question (e.g. a long problem split across screenshots), read them in order, top to bottom, as one continuous problem. If they are unrelated images, address each one.\n\n`
    : '';

  return `${multiImageNote}First, look at the image(s) and figure out what they actually contain, then respond appropriately:

- **If it's a coding problem/question** (LeetCode-style, DSA question, interview question, code with a bug, etc.): reconstruct the full problem statement, list all constraints and example test cases exactly as shown, identify the pattern (sliding window, DP, graph, etc.), then give the most optimized working solution in a clearly marked code block (infer the language from context, default Python if unclear), and state Time Complexity + Space Complexity, confirming if it's optimal or if a better approach exists.
- **If it's a general photo/screenshot/document/diagram** (not a coding problem): just describe or answer about it normally, based on what the user asked.

User's instruction/question (may be empty — if empty, use your judgement based on the image content): "${userInstruction || '(none given — decide based on the image itself)'}"

Do not force a coding-style answer onto a non-coding image, and do not give a plain description of an image that is clearly a coding problem — match the response to what's actually in the image.`;
}

// ── NAYA: Verification wrapper — safe, non-blocking, kabhi bhi original response nahi todega ──
async function tryVerifyAndAnnotate(response) {
  try {
    const hasCodeBlock = /```/.test(response);
    if (!hasCodeBlock) return response;

    const result = await verifyAndFix(response);

    if (!result.applicable) {
      return response; // test cases nahi mile, ya language detect nahi hui — as-is chhodo
    }

    const codeBlockMatch = response.match(/```[\w+]*\n([\s\S]*?)```/);
    if (!codeBlockMatch) return response;

    const langLabel = { javascript: 'javascript', python: 'python', cpp: 'cpp', c: 'c' }[result.language] || '';

    let annotatedResponse;
    if (result.success) {
      const verifiedBlock = `\`\`\`${langLabel}\n${result.code}\n\`\`\`\n\n✅ **Verified:** All ${result.testCasesRun} test case(s) passed (${result.attempts} attempt${result.attempts > 1 ? 's' : ''}).`;
      annotatedResponse = response.replace(codeBlockMatch[0], verifiedBlock);
    } else {
      const failedNote = `\`\`\`${langLabel}\n${result.code}\n\`\`\`\n\n⚠️ **Verification:** Could not pass all test cases after ${result.attempts} attempts. Last issue: ${result.lastReason}`;
      annotatedResponse = response.replace(codeBlockMatch[0], failedNote);
    }

    return annotatedResponse;
  } catch (err) {
    logger.error(`[VERIFY] Verification step failed (non-fatal): ${err.message}`);
    return response; // kuch bhi fail ho, original response hi dikhao
  }
}

/**
 * OPTION 1: File upload (multipart/form-data) — supports MULTIPLE images now
 */
router.post('/', uploadImage.array('images', 5), async (req, res) => {
  try {
    // Backward compatibility: also accept single 'image' field
    let files = req.files;
    if ((!files || files.length === 0) && req.file) files = [req.file];

    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No image uploaded' });
    }

    const { message, chatId } = req.body;
    const userId = req.user?.uid || req.body.userId;
    const userInstruction = message || '';

    logger.info(`[IMAGE] ${files.length} file(s) received`);

    // Build content array: all images first, then the text instruction
    const contentParts = [];

    for (const file of files) {
      const imageUrl = file.path; // cloudinary url
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const base64Image = Buffer.from(imageResponse.data).toString('base64');
      const mimeType = file.mimetype || 'image/jpeg';
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${base64Image}` }
      });
    }

    const promptText = buildAdaptivePrompt(userInstruction, files.length);
    contentParts.push({ type: 'text', text: promptText });

    let response;
    try {
      response = await callVisionModelWithFallback(contentParts, 3072);
    } catch (groqErr) {
      // Surface the REAL error instead of a generic message
      logger.error(`[IMAGE] Vision analysis failed: ${groqErr.message}`);
      throw new Error(`Vision model error: ${groqErr.message}`);
    }

    // ── NAYA STEP — code verify + self-heal (JS, Python, C++, C) ──
    response = await tryVerifyAndAnnotate(response);

    // Cleanup cloudinary temp files
    for (const file of files) {
      try {
        await cloudinary.uploader.destroy(file.filename);
      } catch {}
    }

    // Save to memory — wrapped so a memory-save bug NEVER blocks the actual answer
    if (userId) {
      try {
        await smartSaveMemory(userId, `User shared ${files.length} image(s). ${userInstruction}`, response);
        if (chatId) {
          await saveConversation(userId, `[Image x${files.length}] ${userInstruction}`, response, chatId);
        }
      } catch (memErr) {
        logger.error(`[IMAGE] Memory save failed (non-fatal): ${memErr.message}`);
      }
    }

    logger.info('[IMAGE] Analysis complete');
    res.json({ success: true, response });

  } catch (error) {
    logger.error(`[IMAGE] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * OPTION 2: JSON body with base64 image(s)
 */
router.post('/analyze', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { image, images, message } = req.body;
    const userId = req.user?.uid || req.body.userId;
    const imageList = images && images.length ? images : (image ? [image] : []);

    if (imageList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Image required (base64 or data URL)'
      });
    }

    const userInstruction = message || '';

    logger.info(`[IMAGE] JSON body analysis | ${imageList.length} image(s)`);

    const contentParts = imageList.map(img => {
      let base64Image = img;
      let mimeType = 'image/png';
      if (img.startsWith('data:')) {
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (match) { mimeType = match[1]; base64Image = match[2]; }
      }
      return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } };
    });

    const promptText = buildAdaptivePrompt(userInstruction, imageList.length);
    contentParts.push({ type: 'text', text: promptText });

    let response;
    try {
      response = await callVisionModelWithFallback(contentParts, 3072);
    } catch (groqErr) {
      logger.error(`[IMAGE] Vision analysis failed: ${groqErr.message}`);
      throw new Error(`Vision model error: ${groqErr.message}`);
    }

    // ── NAYA STEP — code verify + self-heal (JS, Python, C++, C) ──
    response = await tryVerifyAndAnnotate(response);

    if (userId) {
      try {
        await smartSaveMemory(userId, `User shared ${imageList.length} image(s). ${userInstruction}`, response);
      } catch (memErr) {
        logger.error(`[IMAGE] Memory save failed (non-fatal): ${memErr.message}`);
      }
    }

    logger.info('[IMAGE] Analysis complete');
    res.json({ success: true, response });

  } catch (error) {
    logger.error(`[IMAGE] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Health check
 */
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'Image service healthy', models: VISION_MODEL_CHAIN });
});

module.exports = router;
