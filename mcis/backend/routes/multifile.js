// backend/routes/multifile.js

const express          = require('express');
const router           = express.Router();
const multiFileService  = require('../services/multiFileService');
const githubService     = require('../services/githubService');
const logger            = require('../services/logger');

// ─── POST /api/multifile/:userId/generate ────────────────────────────────────
// Body: { goal, language, complexity }
// Streams SSE: planning -> file by file -> complete
router.post('/:userId/generate', async (req, res) => {
  const { userId } = req.params;
  const { goal, language = 'javascript', complexity = 'medium' } = req.body;

  if (!goal) return res.status(400).json({ error: 'goal is required' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await multiFileService.generateProject({
      userId,
      goal,
      language,
      complexity,
      onProgress: (event) => send(event),
    });

    send({ type: 'final', result });
  } catch (err) {
    logger.error(`Multi-file generation error for ${userId}: ${err.message}`);
    send({ type: 'fatal_error', error: err.message });
  } finally {
    res.end();
  }
});

// ─── POST /api/multifile/:userId/push ────────────────────────────────────────
// Push an already-generated multi-file project to GitHub
// Body: { repoName, description, files: [{path, content}] }
router.post('/:userId/push', async (req, res) => {
  try {
    const { userId } = req.params;
    const { repoName, description, files } = req.body;

    if (!repoName || !files?.length) {
      return res.status(400).json({ error: 'repoName and files are required' });
    }

    const result = await githubService.createRepoAndPush(userId, {
      repoName,
      description,
      files,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`Multi-file push error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/multifile/:userId/projects ─────────────────────────────────────
router.get('/:userId/projects', async (req, res) => {
  try {
    const { userId } = req.params;
    const projects = await multiFileService.getProjects(userId);
    res.json({ success: true, projects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/multifile/:userId/check-duplicate ──────────────────────────────
router.get('/:userId/check-duplicate', async (req, res) => {
  try {
    const { userId } = req.params;
    const { goal }   = req.query;
    if (!goal) return res.json({ duplicate: null });
    const duplicate = await multiFileService.checkDuplicate(userId, goal);
    res.json({ duplicate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/multifile/:userId/save-project ────────────────────────────────
router.post('/:userId/save-project', async (req, res) => {
  try {
    const { userId } = req.params;
    await multiFileService.saveProject(userId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/multifile/:userId/edit-file ───────────────────────────────────
// Body: { filePath, currentContent, instruction, allFiles, language }
router.post('/:userId/edit-file', async (req, res) => {
  try {
    const { userId } = req.params;
    const { filePath, currentContent, instruction, allFiles, language } = req.body;

    if (!filePath || !currentContent || !instruction) {
      return res.status(400).json({ error: 'filePath, currentContent, instruction are required' });
    }

    const updatedContent = await multiFileService.editFile({
      userId,
      filePath,
      currentContent,
      instruction,
      allFiles: allFiles || [],
      language: language || 'javascript',
    });

    res.json({ success: true, filePath, content: updatedContent });
  } catch (err) {
    logger.error(`Edit file error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;