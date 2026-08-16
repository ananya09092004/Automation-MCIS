const express = require('express');
const router = express.Router();
const multer = require('multer');
const Groq = require('groq-sdk');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { askAI } = require('../services/ai');
const { saveConversation } = require('../services/database');
const { smartSaveMemory } = require('../services/memoryManager');
const { storePdfChunks } = require('../services/pdfVectorStore');
const logger = require('../services/logger');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ✅ FIX: same fallback chain as image.js — scanned-PDF extraction now survives
// a single model going down/rate-limiting instead of failing outright.
const VISION_MODEL_CHAIN = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3.6-27b',
];

function getVisionExtraParams(model) {
  if (model === 'qwen/qwen3.6-27b') {
    return { reasoning_effort: 'none' };
  }
  return {};
}

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
        logger.info(`[UPLOAD] Fallback vision model used: ${model}`);
      }
      return completion.choices[0].message.content;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      logger.warn(`[UPLOAD] Vision model ${model} failed — trying next...`);
    }
  }
  throw new Error(`All vision models failed. Errors: ${errors.join(' | ')}`);
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Phone pe MIME type galat aata hai — filename se fix karo
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.pdf')) file.mimetype = 'application/pdf';
    else if (name.endsWith('.docx')) file.mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (name.endsWith('.doc')) file.mimetype = 'application/msword';
    else if (name.endsWith('.txt')) file.mimetype = 'text/plain';
    else if (name.endsWith('.csv')) file.mimetype = 'text/csv';
    else if (name.endsWith('.json')) file.mimetype = 'application/json';
    else if (name.endsWith('.xlsx')) file.mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (name.endsWith('.xls')) file.mimetype = 'application/vnd.ms-excel';
    cb(null, true);
  }
});

// RAG ke liye small chunks
function splitIntoRagChunks(text, chunkSize = 1000, overlap = 150) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

// AI processing ke liye bade chunks
function splitIntoChunks(text, chunkSize = 4000) {
  const chunks = [];
  const paragraphs = text.split('\n\n');
  let currentChunk = '';
  for (const para of paragraphs) {
    if ((currentChunk + para).length > chunkSize && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += '\n\n' + para;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

// ============================
// FILE EXTRACTORS
// ============================

async function extractFromPDF(fileBuffer, originalName) {

  // Method 1 — pdf-parse (text-based PDFs ke liye fastest)
  try {
    const pdfData = await pdfParse(fileBuffer);
    const text = pdfData.text?.trim();
    if (text && text.length > 100) {
      logger.info(`PDF text-based ✅ — ${text.length} chars`);
      return text;
    }
    logger.info('pdf-parse: not enough text, trying pdfjs...');
  } catch (e) {
    logger.info(`pdf-parse failed: ${e.message}`);
  }

  // Method 2 — pdfjs-dist text extraction
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) });
    const pdfDoc = await loadingTask.promise;
    let allText = '';
    const maxPages = Math.min(pdfDoc.numPages, 10);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(i => i.str).join(' ').trim();
        if (pageText.length > 10) allText += `\nPage ${pageNum}: ${pageText}`;
      } catch (pe) {
        logger.error(`Page ${pageNum}: ${pe.message}`);
      }
    }

    if (allText.trim().length > 100) {
      logger.info(`pdfjs text ✅ — ${allText.length} chars`);
      return allText.trim();
    }
    logger.info('pdfjs: not enough text, trying canvas render...');
  } catch (e) {
    logger.info(`pdfjs text failed: ${e.message}`);
  }

  // Method 3 — Scanned PDF: pdfjs canvas render + vision model (with fallback chain)
  try {
    logger.info('Trying canvas render for scanned PDF...');
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');

    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) });
    const pdfDoc = await loadingTask.promise;
    const maxPages = Math.min(pdfDoc.numPages, 3);
    let allExtractedText = '';

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');

        await page.render({ canvasContext: context, viewport }).promise;

        const base64Image = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
        logger.info(`Page ${pageNum} rendered ✅ — sending to vision model...`);

        const contentParts = [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
          },
          {
            type: 'text',
            text: `Extract ALL visible text from this PDF page (page ${pageNum} of "${originalName}"). Return only the text content, preserve formatting as much as possible.`
          }
        ];

        const pageText = await callVisionModelWithFallback(contentParts, 2048);
        if (pageText) {
          allExtractedText += `\n--- Page ${pageNum} ---\n${pageText}`;
          logger.info(`Page ${pageNum} vision extracted ✅ — ${pageText.length} chars`);
        }

      } catch (pageErr) {
        logger.error(`Page ${pageNum} canvas/vision error: ${pageErr.message}`);
      }
    }

    if (allExtractedText.trim().length > 100) {
      logger.info(`Scanned PDF total: ${allExtractedText.length} chars`);
      return allExtractedText.trim();
    }

  } catch (e) {
    logger.error(`Canvas render failed: ${e.message}`);
  }

  return null;
}

async function extractFromDOCX(fileBuffer) {
  try {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    const text = result.value?.trim();
    if (text && text.length > 10) {
      logger.info(`DOCX extracted ✅ — ${text.length} chars`);
      return text;
    }
  } catch (e) {
    logger.error(`DOCX error: ${e.message}`);
  }
  return null;
}

async function extractFromXLSX(fileBuffer) {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    let allText = '';
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) allText += `\n[Sheet: ${sheetName}]\n${csv}`;
    }
    if (allText.trim().length > 10) {
      logger.info(`XLSX extracted ✅ — ${allText.length} chars`);
      return allText.trim();
    }
  } catch (e) {
    logger.error(`XLSX error: ${e.message}`);
  }
  return null;
}

async function extractText(fileBuffer, mimeType, originalName) {
  const name = originalName.toLowerCase();
  logger.info(`Extracting: ${originalName} | MIME: ${mimeType} | Size: ${(fileBuffer.length / 1024).toFixed(1)}KB`);

  if (name.endsWith('.pdf') || mimeType.includes('pdf')) {
    return await extractFromPDF(fileBuffer, originalName);
  }

  if (name.endsWith('.docx') || name.endsWith('.doc') ||
    mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
    return await extractFromDOCX(fileBuffer);
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls') ||
    mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return await extractFromXLSX(fileBuffer);
  }

  if (name.endsWith('.csv') || mimeType.includes('csv')) {
    const text = fileBuffer.toString('utf-8');
    logger.info(`CSV extracted ✅ — ${text.length} chars`);
    return text.slice(0, 20000);
  }

  if (name.endsWith('.txt') || name.endsWith('.json') || name.endsWith('.md') ||
    mimeType.includes('text') || mimeType.includes('json')) {
    const text = fileBuffer.toString('utf-8');
    logger.info(`Text file extracted ✅ — ${text.length} chars`);
    return text.slice(0, 20000);
  }

  try {
    const text = fileBuffer.toString('utf-8').trim();
    if (text.length > 50) {
      logger.info(`Generic text extracted ✅ — ${text.length} chars`);
      return text.slice(0, 20000);
    }
  } catch {}

  return null;
}

// ============================
// MAIN ROUTE
// ============================

router.post('/', upload.single('file'), async (req, res) => {
  try {
    logger.info('=== FILE UPLOAD DEBUG ===');
    logger.info(`req.file: ${JSON.stringify({
      name: req.file?.originalname,
      mime: req.file?.mimetype,
      size: req.file?.size
    })}`);
    logger.info(`req.body keys: ${JSON.stringify(Object.keys(req.body))}`);

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file received. Please try again.' });
    }

    const { message, chatId } = req.body;
    const userId = req.user?.uid || req.body.userId;
    const userMessage = message || 'Please analyze this file and give me a detailed summary';
    const originalName = req.file.originalname;
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const fileBuffer = req.file.buffer;

    // Text extract karo
    const fileText = await extractText(fileBuffer, mimeType, originalName);

    if (!fileText) {
      return res.status(400).json({
        success: false,
        error: `Could not read "${originalName}". Supported formats: PDF (text + scanned), Word (.docx), Excel (.xlsx), CSV, TXT, JSON.`
      });
    }

    logger.info(`Extracted ${fileText.length} chars from ${originalName}`);

    // RAG — PDF chunks Pinecone mein store karo (background mein, non-blocking already)
    if (userId && (originalName.toLowerCase().endsWith('.pdf') || mimeType.includes('pdf'))) {
      const ragChunks = splitIntoRagChunks(fileText, 1000, 150);
      logger.info(`Storing ${ragChunks.length} PDF chunks in Pinecone (background)...`);
      storePdfChunks(userId, originalName, ragChunks).then(() => {
        logger.info(`PDF chunks stored ✅ — ${originalName}`);
      }).catch(e => {
        logger.error(`PDF chunk store error: ${e.message}`);
      });
    }

    // User intent detect karo
    const lowerMsg = (userMessage || '').toLowerCase();
    const wantsNames = /\b(name|names|student|students|participants|people)\b/i.test(lowerMsg);
    const wantsEmails = /\b(email|emails|mail id|mail ids)\b/i.test(lowerMsg);
    const wantsPhones = /\b(phone|phones|mobile|contact number)\b/i.test(lowerMsg);
    const wantsCompanies = /\b(company|companies|organization|organisations)\b/i.test(lowerMsg);

    let finalResponse = '';
    const CHUNK_SIZE = 4000;

    if (fileText.length <= CHUNK_SIZE) {
      // Short file
      if (wantsNames) {
        finalResponse = await askAI(
          'Extract ALL names from this document. Return a numbered list. Do not summarize.',
          fileText, [], ''
        );
      } else {
        finalResponse = await askAI(
          userMessage,
          `File "${originalName}" content:\n---\n${fileText}\n---\nAnswer based on this content.`,
          [], ''
        );
      }

    } else {
      // Large file — chunking
      const chunks = splitIntoChunks(fileText, CHUNK_SIZE);
      logger.info(`Large file — ${chunks.length} chunks`);

      let chunkPrompt = '';
      if (wantsNames) chunkPrompt = 'Extract ALL person names from this section. Return only names exactly as written. Do not summarize.';
      else if (wantsEmails) chunkPrompt = 'Extract ALL email addresses from this section. Return only emails.';
      else if (wantsPhones) chunkPrompt = 'Extract ALL phone/mobile numbers from this section. Return only numbers.';
      else if (wantsCompanies) chunkPrompt = 'Extract ALL company/organization names from this section. Return only company names.';
      else chunkPrompt = 'Extract all important information, facts, insights, tables and key points from this section.';

      const summaries = [];
      for (let i = 0; i < chunks.length; i++) {
        try {
          const s = await askAI(
            chunkPrompt,
            `Part ${i + 1} of ${chunks.length} from "${originalName}":\n${chunks[i]}`,
            [], ''
          );
          summaries.push(s);
          logger.info(`Chunk ${i + 1}/${chunks.length} processed ✅`);
        } catch (e) {
          logger.error(`Chunk ${i + 1} error: ${e.message}`);
        }
      }

      // Special handling for names — deduplicate locally
      if (wantsNames) {
        const allText = summaries.join('\n');
        const names = [...new Set(
          allText
            .split('\n')
            .map(n => n.trim())
            .filter(n => n.length > 2)
            .filter(n => !n.toLowerCase().includes('extract'))
            .filter(n => !n.toLowerCase().includes('name'))
        )];

        const totalNames = names.length;
        const sampleNames = names.slice(0, 20).join('\n');
        finalResponse = `Total names found: ${totalNames}\n\nSample names:\n${sampleNames}${totalNames > 20 ? `\n\n...and ${totalNames - 20} more names.` : ''}`;

      } else {
        // Other intents — AI se final answer lo
        let finalPrompt = '';
        if (wantsEmails) finalPrompt = 'Combine all extracted emails. Remove duplicates. Return only the email list.';
        else if (wantsPhones) finalPrompt = 'Combine all extracted phone numbers. Remove duplicates. Return only the phone numbers.';
        else if (wantsCompanies) finalPrompt = 'Combine all extracted company names. Remove duplicates. Return only the company names.';
        else finalPrompt = `Answer the user query in detail based on all extracted content: ${userMessage}`;

        finalResponse = await askAI(
          finalPrompt,
          summaries.join('\n\n'),
          [], ''
        );
      }
    }

    // ✅ FIX: memory save wrapped so a memory-save bug NEVER blocks the actual answer
    // (same bug class that broke the image route — detectAndSavePreferences crash)
    if (userId) {
      try {
        await smartSaveMemory(userId, `Uploaded: ${originalName}. ${userMessage}`, finalResponse);
        if (chatId) {
          await saveConversation(userId, `[File: ${originalName}] ${userMessage}`, finalResponse, chatId);
        }
      } catch (memErr) {
        logger.error(`[UPLOAD] Memory save failed (non-fatal): ${memErr.message}`);
      }
    }

    res.json({ success: true, response: finalResponse, fileName: originalName });

  } catch (error) {
    logger.error(`Upload route error: ${error.message}`);
    logger.error(error.stack);
    res.status(500).json({ success: false, error: `Server error: ${error.message}` });
  }
});

module.exports = router;
