const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Identify failure location using delta debugging concept
async function locateFailure(code, failingTest) {
  try {
    const prompt = `Analyze code failure and locate exact problematic section:

Code:
\`\`\`
${code}
\`\`\`

Failing test input: ${JSON.stringify(failingTest.input)}
Expected output: ${failingTest.expected}

Identify:
1. Which section of code is responsible?
2. What's the root cause?
3. What's the minimal fix?

Return JSON:
{
  "failing_section": "lines 5-12 (the loop)",
  "root_cause": "Loop condition doesn't handle...",
  "fix_type": "logic-error",
  "minimal_fix": "Change 'while i < n' to 'while i <= n'",
  "explanation": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, analysis };
  } catch (err) {
    logger.error(`Locate failure error: ${err.message}`);
    return { success: false };
  }
}

// Apply surgical repair (minimal fix)
async function applySurgicalRepair(code, analysis) {
  try {
    const prompt = `Apply minimal surgical repair to code:

Original code:
\`\`\`
${code}
\`\`\`

Problem location: ${analysis.failing_section}
Root cause: ${analysis.root_cause}
Minimal fix needed: ${analysis.minimal_fix}

Generate ONLY the repaired code.
Make minimal changes ONLY to fix the issue.
Don't rewrite entire code.

Return the fixed code only (no explanation).`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.3
    });

    const repairedCode = completion.choices[0].message.content
      .replace(/```python|```java|```javascript|```/g, '')
      .trim();

    return { success: true, repaired_code: repairedCode };
  } catch (err) {
    logger.error(`Apply repair error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  locateFailure,
  applySurgicalRepair
};