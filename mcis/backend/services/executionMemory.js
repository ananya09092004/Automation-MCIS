// backend/services/executionMemory.js

const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq     = new Groq({ apiKey: process.env.GROQ_API_KEY });

class ExecutionMemory {

  // â”€â”€â”€ 1. Extract pattern from execution (not raw code) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async extractPattern(goal, error, fix, language) {
    if (!error) return null;

    const prompt = `
Analyze this code execution:
Goal: ${goal}
Language: ${language}
Error that occurred: ${error}
How it was fixed: ${fix}

Extract a reusable pattern in JSON:
{
  "error_type": "short category like 'missing dependency' or 'syntax error'",
  "error_summary": "one line description",
  "fix_summary": "one line fix description",
  "tags": ["tag1", "tag2"],
  "language": "${language}"
}

Return ONLY the JSON. No explanation.
`;

    try {
      const completion = await groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  300,
      });

      const text    = completion.choices[0].message.content.trim();
      const cleaned = text.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  // â”€â”€â”€ 2. Save execution (pattern only â€” not raw code) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async save(userId, { goal, language, output, error, fix, attempts, success }) {
    try {
      // Only extract pattern if there was an error
      const pattern = error
        ? await this.extractPattern(goal, error, fix || '', language)
        : null;

      const { data, err } = await supabase
        .from('execution_memory')
        .insert([{
          user_id:       userId,
          goal_summary:  goal.slice(0, 200),          // cap length
          language,
          success,
          attempts,
          error_type:    pattern?.error_type    || null,
          error_summary: pattern?.error_summary || null,
          fix_summary:   pattern?.fix_summary   || null,
          tags:          pattern?.tags          || [],
          created_at:    new Date().toISOString(),
        }]);

      if (err) console.error('ExecutionMemory save error:', err.message);
    } catch (e) {
      console.error('ExecutionMemory save failed:', e.message);
    }
  }

  // â”€â”€â”€ 3. Get relevant past patterns for a new goal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async getRelevantPatterns(userId, goal, language) {
    try {
      // Get recent failures for this user + language
      const { data, error } = await supabase
        .from('execution_memory')
        .select('goal_summary, error_type, error_summary, fix_summary, tags, attempts')
        .eq('user_id', userId)
        .eq('language', language)
        .eq('success', true)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error || !data?.length) return null;

      // Find patterns related to this goal
      const related = data.filter(row =>
        row.tags?.some(tag =>
          goal.toLowerCase().includes(tag.toLowerCase())
        ) || goal.toLowerCase().includes((row.goal_summary || '').toLowerCase().split(' ')[0])
      );

      if (!related.length) return null;

      return related.map(r => `- ${r.error_type}: ${r.fix_summary}`).join('\n');
    } catch {
      return null;
    }
  }

  // â”€â”€â”€ 4. Get user's execution stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async getStats(userId) {
    try {
      const { data, error } = await supabase
        .from('execution_memory')
        .select('success, attempts, language, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error || !data?.length) return null;

      const total      = data.length;
      const successful = data.filter(d => d.success).length;
      const avgAttempts = data.reduce((a, b) => a + (b.attempts || 1), 0) / total;
      const languages  = [...new Set(data.map(d => d.language))];

      return {
        total,
        successRate:  ((successful / total) * 100).toFixed(0) + '%',
        avgAttempts:  avgAttempts.toFixed(1),
        languages,
      };
    } catch {
      return null;
    }
  }
}

module.exports = new ExecutionMemory();