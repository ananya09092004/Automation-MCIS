// backend/services/sandboxService.js

const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const JUDGE0_API_HOST = process.env.JUDGE0_API_HOST || 'judge0-ce.p.rapidapi.com';
const JUDGE0_API_KEY  = process.env.JUDGE0_API_KEY;

const JUDGE0_LANGUAGE_IDS = {
  javascript: 63,
  js:         63,
  python:     71,
  py:         71,
  typescript: 74,
  ts:         74,
  java:       62,
  cpp:        54,
  c:          50,
};

class SandboxService {

  // ─── 1. Run code on Judge0 ───────────────────────────────────────────────
  async runCode(code, language = 'javascript', stdin = '') {
    const langId = JUDGE0_LANGUAGE_IDS[language.toLowerCase()];
    if (!langId) throw new Error(`Language not supported: ${language}`);

    const response = await fetch(
      `https://${JUDGE0_API_HOST}/submissions?base64_encoded=false&wait=true`,
      {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-RapidAPI-Key':  JUDGE0_API_KEY,
          'X-RapidAPI-Host': JUDGE0_API_HOST,
        },
        body: JSON.stringify({
          source_code: code,
          language_id: langId,
          stdin:       stdin,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Judge0 API error: ${errText}`);
    }

    const data = await response.json();
    const stdout  = data.stdout || '';
    const stderr  = data.stderr || data.compile_output || '';
    const success = data.status?.id === 3 && !stderr;

    return {
      stdout,
      stderr,
      code:    data.status?.id,
      success,
    };
  }

  // ─── 2. Generate code via Groq ───────────────────────────────────────────
  async generateCode(goal, language = 'javascript', context = '') {
    const prompt = `
You are an expert ${language} developer.
Goal: ${goal}
${context ? `Context / previous error:\n${context}` : ''}

Write ONLY the complete, working ${language} code.
No explanation. No markdown. No backticks. Just raw code.
The code must run standalone and produce visible output.
`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens:  2048,
    });

    return completion.choices[0].message.content.trim();
  }

  // ─── 3. Fix code via Groq ────────────────────────────────────────────────
  async fixCode(code, error, goal, language = 'javascript') {
    const prompt = `
You are an expert ${language} developer debugging code.

Original goal: ${goal}

Broken code:
${code}

Error:
${error}

Fix the code completely. Return ONLY the fixed code.
No explanation. No markdown. No backticks. Just raw working code.
`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens:  2048,
    });

    return completion.choices[0].message.content.trim();
  }

  // ─── 4. Explain what happened (for teaching mode) ────────────────────────
  async explainExecution(code, result, goal, language = 'javascript') {
    const prompt = `
You are a coding teacher explaining what happened.

Goal: ${goal}
Language: ${language}

Code written:
${code}

Result:
${result.stdout || result.stderr}

Explain in 3-4 simple lines:
1. What the code does
2. Why this approach was used
3. One key pattern to remember

Be concise and friendly.
`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });

    return completion.choices[0].message.content.trim();
  }

  // ─── 5. MAIN: Self-healing execution loop ────────────────────────────────
  async executeWithHealing({
    goal,
    language    = 'javascript',
    maxAttempts = 5,
    teachMode   = false,
    onProgress  = () => {},          // callback for SSE streaming
  }) {
    let code     = '';
    let attempt  = 0;
    let lastError = '';

    onProgress({ type: 'start', message: `Starting: ${goal}` });

    // Step 1 — generate initial code
    onProgress({ type: 'generating', message: 'Generating code...' });
    code = await this.generateCode(goal, language, '');
    onProgress({ type: 'code_generated', code });

    // Step 2 — self-healing loop
    while (attempt < maxAttempts) {
      attempt++;
      onProgress({ type: 'running', message: `Running code (attempt ${attempt})...` });

      const result = await this.runCode(code, language);

      if (result.success) {
        // ✅ Success
        onProgress({ type: 'success', output: result.stdout, code, attempt });

        // Teaching moment
        if (teachMode) {
          onProgress({ type: 'teaching', message: 'Analyzing what you learned...' });
          const explanation = await this.explainExecution(code, result, goal, language);
          onProgress({ type: 'explanation', explanation });
        }

        return {
          success:    true,
          code,
          output:     result.stdout,
          attempts:   attempt,
          explanation: teachMode
            ? await this.explainExecution(code, result, goal, language)
            : null,
        };
      }

      // ❌ Error — try to fix
      lastError = result.stderr || result.stdout;
      onProgress({
        type:    'error',
        message: `Error on attempt ${attempt}. Fixing...`,
        error:   lastError,
      });

      if (attempt < maxAttempts) {
        code = await this.fixCode(code, lastError, goal, language);
        onProgress({ type: 'fixed', message: 'Code fixed. Retrying...', code });
      }
    }

    // All attempts exhausted
    onProgress({
      type:    'failed',
      message: `Could not fix after ${maxAttempts} attempts.`,
      error:   lastError,
      code,
    });

    return {
      success:  false,
      code,
      error:    lastError,
      attempts: attempt,
    };
  }
}

module.exports = new SandboxService();