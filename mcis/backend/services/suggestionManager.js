const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateSuggestions(userMessage, aiResponse, userContext = '') {
  try {
    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'system',
          content: `Generate 3 short follow-up suggestions based on the conversation.
Rules:
- Each suggestion max 6 words
- Make them actionable and specific
- Based on what user just discussed
- Return ONLY valid JSON array: ["suggestion1", "suggestion2", "suggestion3"]
- No extra text, no markdown, just the JSON array`
        },
        {
          role: 'user',
          content: `User said: ${userMessage.slice(0, 200)}\nAI replied: ${aiResponse.slice(0, 200)}\n\nGenerate 3 follow-up suggestions:`
        }
      ],
      max_tokens: 100,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content.trim();
    const suggestions = JSON.parse(text);
    if (Array.isArray(suggestions)) return suggestions.slice(0, 3);
    return [];
  } catch {
    return [];
  }
}

module.exports = { generateSuggestions };