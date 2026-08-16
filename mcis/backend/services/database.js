const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Save new chat
async function saveChat(chatId, userId, title) {
  try {
    const { error } = await supabase
      .from('chats')
      .insert([{ id: chatId, user_id: userId, title, created_at: new Date().toISOString() }]);
    if (error) throw error;
    console.log('Chat saved ✅');
  } catch (err) {
    console.error('Save chat error:', err.message);
  }
}

// Update chat title
async function updateChatTitle(chatId, title) {
  try {
    const { error } = await supabase
      .from('chats')
      .update({ title })
      .eq('id', chatId);
    if (error) throw error;
  } catch (err) {
    console.error('Update chat error:', err.message);
  }
}

// Delete chat
async function deleteChat(chatId) {
  try {
    await supabase.from('conversations').delete().eq('chat_id', chatId);
    await supabase.from('chats').delete().eq('id', chatId);
    console.log('Chat deleted ✅');
  } catch (err) {
    console.error('Delete chat error:', err.message);
  }
}

// Get all chats for user
async function getUserChats(userId) {
  try {
    const { data, error } = await supabase
      .from('chats')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Get chats error:', err.message);
    return [];
  }
}

// Save conversation
async function saveConversation(userId, message, response, chatId) {
  try {
    const { error } = await supabase
      .from('conversations')
      .insert([{
        user_id: userId,
        message,
        response,
        chat_id: chatId,
        created_at: new Date().toISOString()
      }]);
    if (error) throw error;
    console.log('Conversation saved ✅');
  } catch (err) {
    console.error('Supabase error:', err.message);
  }
}

// Get chat history
async function getHistory(userId, chatId, limit = 20) {
  try {
    // For small limits (e.g. the early-fire planner pre-fetch) we want the
    // MOST RECENT turns, not the oldest — so fetch descending then reverse
    // when a tighter limit is requested.
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .order('created_at', { ascending: limit >= 20 })
      .limit(limit);
    if (error) throw error;
    if (!data) return [];
    return limit >= 20 ? data : data.reverse();
  } catch (err) {
    console.error('History error:', err.message);
    return [];
  }
}

module.exports = { saveChat, updateChatTitle, deleteChat, getUserChats, saveConversation, getHistory };