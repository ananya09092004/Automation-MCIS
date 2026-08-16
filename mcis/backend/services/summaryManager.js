const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Strip think tags
const clean = (text = '') =>
  text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

async function generateChatSummary(userId, chatId, messages) {
  try {
    if (!messages || messages.length < 1) return null;

    const recentMessages = messages.slice(-10);
    const conversationText = recentMessages
      .map(m => `User: ${m.message?.slice(0, 200)}\nMCIS: ${m.response?.slice(0, 200)}`)
      .join('\n\n');

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      reasoning_effort: 'none',
      messages: [
        {
          role: 'system',
          content: `Summarize this conversation in 2-3 sentences.
- Write in second person ("You discussed...")
- Mention what was done and what is pending
- Be specific, not vague
- Return ONLY the summary`
        },
        {
          role: 'user',
          content: `Summarize:\n\n${conversationText}`
        }
      ],
      max_tokens: 150,
      temperature: 0.3
    });

    const summary = clean(completion.choices[0].message.content);
    console.log('Summary generated:', summary.slice(0, 80));

    await supabase
      .from('chat_summaries')
      .delete()
      .eq('chat_id', chatId);

    const { error } = await supabase
      .from('chat_summaries')
      .insert([{
        user_id: userId,
        chat_id: chatId,
        summary,
        created_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('Summary save error:', error.message);
    } else {
      console.log('Summary saved ✅');
    }

    return summary;
  } catch (err) {
    console.error('Summary error:', err.message);
    return null;
  }
}

async function getLastChatSummary(userId, currentChatId) {
  try {
    const { data, error } = await supabase
      .from('chat_summaries')
      .select('*')
      .eq('user_id', userId)
      .neq('chat_id', currentChatId)
      .order('created_at', { ascending: false })
      .limit(1);

    console.log('Summary rows found:', data?.length);
    if (error || !data || data.length === 0) return null;
    return data[0].summary;
  } catch (err) {
    console.error('getLastChatSummary error:', err.message);
    return null;
  }
}

async function generateWelcomeMessage(userId, currentChatId) {
  try {
    const lastSummary = await getLastChatSummary(userId, currentChatId);
    console.log('Last summary found:', lastSummary ? 'YES' : 'NO');

    if (!lastSummary) {
      return "Hello! I am MCIS. How can I help you today?";
    }

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      reasoning_effort: 'none',
      messages: [
        {
          role: 'system',
          content: `You are MCIS, a personal AI assistant.
Generate a warm welcome message for a returning user.
- Max 2 sentences
- Mention what was last worked on
- Ask what to do next
- Be natural, not robotic
- Return ONLY the welcome message`
        },
        {
          role: 'user',
          content: `Last session: ${lastSummary}\n\nGenerate welcome:`
        }
      ],
      max_tokens: 100,
      temperature: 0.7
    });

    return clean(completion.choices[0].message.content);
  } catch (err) {
    console.error('Welcome message error:', err.message);
    return "Welcome back! Where were we? How can I help you today?";
  }
}

module.exports = { generateChatSummary, getLastChatSummary, generateWelcomeMessage };