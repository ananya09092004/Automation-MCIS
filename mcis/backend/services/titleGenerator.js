const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateChatTitle(userMessage, aiResponse) {
  const models = ['llama-3.3-70b-versatile', 'gemma2-9b-it', 'mixtral-8x7b-32768'];

  for (const model of models) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `Generate a very short chat title (max 4 words).
Rules: No quotes, Capitalize each word, Be specific.
Examples: "React Project Help", "Delhi Weather Query", "Python Debug Session"
Return ONLY the title, nothing else.`
          },
          {
            role: 'user',
            content: `User: ${userMessage.slice(0, 150)}`
          }
        ],
        model,
        max_tokens: 15,
        temperature: 0.3
      });

      return completion.choices[0].message.content.trim().slice(0, 50);
    } catch {
      continue;
    }
  }

  return userMessage.split(' ').slice(0, 4).join(' ');
}

module.exports = { generateChatTitle };