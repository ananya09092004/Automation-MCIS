// backend/services/multiFileService.js
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const executionMemory = require('./executionMemory');

const groq     = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Ordered fallback chain of free Groq models. If the first model is rate-limited
// or errors out, we automatically retry with the next one in the list.
// Update this list if Groq deprecates/adds models — check console.groq.com/docs/deprecations
const MODEL_FALLBACK_CHAIN = [
  'openai/gpt-oss-120b',    // best quality, use first for complex/production-grade generation
  'openai/gpt-oss-20b',     // fast, solid fallback (previous default model)
  'llama-3.1-8b-instant',   // extra fallback, different family/quota bucket, higher free-tier TPM
  'qwen/qwen3.6-27b',       // last resort, smallest free-tier TPM budget of the chain
];

// Each Groq free-tier model has its own tokens-per-minute (TPM) ceiling. A request whose
// prompt + max_tokens exceeds that ceiling gets rejected outright (HTTP 413) no matter how
// many times we retry — so we cap max_tokens per model instead of always using the caller's
// requested value. Keep some headroom under each model's real limit for the prompt itself.
const MODEL_MAX_TOKENS_CAP = {
  'qwen/qwen3.6-27b': 6000,
};

function capMaxTokensForModel(model, requestedMaxTokens) {
  const cap = MODEL_MAX_TOKENS_CAP[model];
  if (!cap) return requestedMaxTokens;
  return Math.min(requestedMaxTokens, cap);
}

// ✅ NEW: complexity presets driving both prompt guidance and file-count targets
const COMPLEXITY_PRESETS = {
  simple: {
    label: 'Simple / MVP',
    fileRange: '2-5',
    guidance: `Keep this as small and minimal as possible — just enough files to make it actually work.
Skip tests, skip advanced config, skip nice-to-haves. A single main file plus maybe a style/config file is often enough.
Think "quick prototype a beginner could build in an hour", not a polished product.`,
  },
  medium: {
    label: 'Medium / Standard',
    fileRange: '6-12',
    guidance: `Build a clean, working, reasonably organized project — the kind a solo developer would ship for a small real project.
Some separation of concerns is good (e.g. a routes file separate from logic), but don't over-engineer.
Include a README. Skip elaborate test suites unless the goal explicitly asks for testing.`,
  },
  complex: {
    label: 'Complex / Production-grade',
    fileRange: '13-25',
    guidance: `Design a complete, well-structured, production-grade file layout as if it were going into a real company codebase.
Include proper separation of concerns (routes/controllers, services/business logic, models/schemas, utils, config),
error handling and validation, a basic test file if the stack supports it, styling/UI files if frontend,
config files (.env.example, package.json), and a thorough README.`,
  },
};

function isRateLimitOrCapacityError(err) {
  const status = err?.status || err?.response?.status;
  const message = (err?.message || '').toLowerCase();
  return (
    status === 413 ||
    status === 429 ||
    status === 503 ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too large') ||
    message.includes('capacity') ||
    message.includes('quota')
  );
}

// Tries each model in MODEL_FALLBACK_CHAIN in order until one succeeds.
// Throws the last error if every model in the chain fails.
// NOTE: fallback is intentionally SILENT to the user — only logged server-side,
// never sent via onProgress, so the frontend never reveals which model is active.
async function createCompletionWithFallback({ messages, temperature = 0.3, max_tokens = 4096 }, onProgress = () => {}) {
  let lastError;
  for (let i = 0; i < MODEL_FALLBACK_CHAIN.length; i++) {
    const model = MODEL_FALLBACK_CHAIN[i];
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: capMaxTokensForModel(model, max_tokens),
      });
      return completion;
    } catch (err) {
      lastError = err;
      if (isRateLimitOrCapacityError(err)) {
        // server-side log only — never surfaced to the user via onProgress
        console.warn(`[model fallback] ${model} unavailable (${err.message}), trying next model`);
        // Small backoff before hitting the next model — helps with transient
        // org-wide rate limits rather than just a per-model quota problem.
        if (i < MODEL_FALLBACK_CHAIN.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        continue;
      }
      // Non rate-limit error (bad request, auth, etc) — no point retrying other models
      throw err;
    }
  }
  throw lastError || new Error('All fallback models failed');
}

// Turns any raw provider/network error into a short, non-technical message safe
// to show in the UI. Full error detail is always still logged server-side.
function toUserFacingError(err) {
  console.error('[multifile] generation error:', err?.message || err);
  const message = (err?.message || '').toLowerCase();
  if (isRateLimitOrCapacityError(err) || message.includes('too large')) {
    return 'High demand right now — please try again in a minute.';
  }
  return 'Something went wrong while generating this part of the project. Please try again.';
}

function cleanResponse(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json|```/g, '')
    .trim();
}

class MultiFileService {

  // ✅ CHANGED: now accepts `complexity` and shapes the prompt/file-count target accordingly
  async planProject(goal, language = 'javascript', complexity = 'medium') {
    const conf = COMPLEXITY_PRESETS[complexity] || COMPLEXITY_PRESETS.medium;

    const prompt = `You are a senior software architect.

Goal: ${goal}
Language/Stack: ${language}
Requested complexity level: ${conf.label}

${conf.guidance}

Return ONLY valid JSON in this exact format:

{
  "projectName": "short-kebab-case-name",
  "description": "one line description",
  "files": [
    { "path": "relative/path/to/file.ext", "purpose": "what this file does" }
  ]
}

Rules:
- Aim for roughly ${conf.fileRange} files given the requested complexity level above — do not exceed this range by much, and do not pad with unnecessary files just to hit a number.
- Every file must have a clear, distinct purpose — no filler files.
- Return ONLY the JSON. No markdown, no backticks, no explanation, no thinking tags.`;

    const completion = await createCompletionWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens:  4096,
    });

    const raw     = completion.choices[0].message.content || '';
    const cleaned = cleanResponse(raw);

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      throw new Error('Failed to plan project structure: ' + e.message);
    }
  }

  async generateFileContent(file, goal, allFiles, language) {
    const fileList = allFiles.map(f => `- ${f.path}: ${f.purpose}`).join('\n');

    const prompt = `You are an expert ${language} developer building a complete, production-grade project.

Overall project goal: ${goal}

Full project structure:
${fileList}

Now write the COMPLETE content for this specific file:
Path: ${file.path}
Purpose: ${file.purpose}

Rules:
- Write real, production-quality, fully working code — not a stub or simplified placeholder
- Include proper error handling, input validation, and edge-case handling where relevant
- Add brief comments for non-obvious logic
- Make sure this file correctly integrates with the other files in the project structure above (matching imports, exports, function/variable names, and conventions)
- No explanation, no markdown, no backticks, no thinking tags - just the raw file content`;

    const completion = await createCompletionWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens:  8192,
    });

    const raw = completion.choices[0].message.content || '';
    return cleanResponse(raw);
  }

  // ✅ CHANGED: accepts `complexity`, passes it into planProject
  async generateProject({ userId, goal, language = 'javascript', complexity = 'medium', onProgress = () => {} }) {
    const startTime = Date.now();
    onProgress({ type: 'start', message: `Planning project: ${goal}` });

    let memoryContext = '';
    try {
      const patterns = await executionMemory.getRelevantPatterns(userId, goal, language);
      if (patterns) {
        memoryContext = patterns;
        onProgress({ type: 'memory', message: 'Found relevant past patterns', patterns });
      }
    } catch (_) {}

    onProgress({ type: 'planning', message: 'Designing project structure...' });
    let plan;
    try {
      plan = await this.planProject(
        memoryContext ? `${goal}\n\nKnown issues to avoid:\n${memoryContext}` : goal,
        language,
        complexity
      );
    } catch (err) {
      const safeError = toUserFacingError(err);
      onProgress({ type: 'fatal_error', error: safeError });
      return { success: false, error: safeError };
    }

    onProgress({ type: 'plan_ready', message: `Project planned: ${plan.files.length} files`, plan });

    const generatedFiles = [];
    for (let i = 0; i < plan.files.length; i++) {
      const file = plan.files[i];
      onProgress({ type: 'generating_file', message: `Writing ${file.path} (${i + 1}/${plan.files.length})...`, file: file.path });

      try {
        const content = await this.generateFileContent(file, goal, plan.files, language);
        generatedFiles.push({ path: file.path, content, purpose: file.purpose });
        onProgress({ type: 'file_generated', file: file.path, preview: content.slice(0, 200) });
      } catch (err) {
        onProgress({ type: 'file_error', file: file.path, error: toUserFacingError(err) });
      }
    }

    const success = generatedFiles.length === plan.files.length;

    try {
      await executionMemory.save(userId, {
        goal, language,
        output:   `Generated ${generatedFiles.length} files`,
        error:    success ? null : 'Some files failed to generate',
        fix: null, attempts: 1, success,
      });
    } catch (_) {}

    onProgress({
      type: 'complete', message: `Project ready: ${plan.projectName}`,
      project: { name: plan.projectName, description: plan.description },
      files: generatedFiles, timeMs: Date.now() - startTime,
    });

    return { success, projectName: plan.projectName, description: plan.description, files: generatedFiles };
  }

  async editFile({ userId, filePath, currentContent, instruction, allFiles = [], language = 'javascript' }) {
    const fileList = allFiles.length ? allFiles.map(f => `- ${f.path}`).join('\n') : '(no other files provided)';

    const prompt = `You are an expert ${language} developer editing an existing file.

Project files:
${fileList}

File being edited: ${filePath}

Current content:
${currentContent}

User requested change:
${instruction}

Rewrite the COMPLETE file with the change applied.
Return ONLY the complete updated file content. No explanation, no markdown, no thinking tags.`;

    const completion = await createCompletionWithFallback({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 8192,
    });

    const raw = completion.choices[0].message.content || '';
    const updatedContent = cleanResponse(raw);

    try {
      await executionMemory.save(userId, {
        goal: `Edit ${filePath}: ${instruction}`,
        language, output: 'File edited successfully',
        error: null, fix: null, attempts: 1, success: true,
      });
    } catch (_) {}

    return updatedContent;
  }

  async saveProject(userId, { projectName, description, goal, language, filesCount, repoUrl, vsCodeUrl, codespacesUrl, files }) {
    try {
      await supabase.from('generated_projects').insert([{
        user_id: userId, project_name: projectName, description,
        goal: goal.slice(0, 300), language, files_count: filesCount,
        files: files || null, repo_url: repoUrl || null,
        vs_code_url: vsCodeUrl || null, codespaces_url: codespacesUrl || null,
        created_at: new Date().toISOString(),
      }]);
    } catch (e) { console.error('saveProject error:', e.message); }
  }

  async checkDuplicate(userId, goal) {
    try {
      const { data } = await supabase
        .from('generated_projects').select('id, project_name, created_at, repo_url')
        .eq('user_id', userId).ilike('goal', `%${goal.slice(0, 50)}%`)
        .order('created_at', { ascending: false }).limit(1);
      if (data?.length > 0) return data[0];
      return null;
    } catch { return null; }
  }

  async getProjects(userId) {
    try {
      const { data, error } = await supabase
        .from('generated_projects').select('*')
        .eq('user_id', userId).order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch { return []; }
  }
}

module.exports = new MultiFileService();