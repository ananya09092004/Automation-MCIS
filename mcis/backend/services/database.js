const { createClient } = require('@supabase/supabase-js');
// Layer 2: inside a workspace-scoped request (see middleware/workspaceDataScope.js)
// every chat/conversation read and write below is limited to the caller's
// workspace. Outside a scoped request (no scope) behaviour is unchanged.
const { currentScope, applyScope, scopeFields, ownedInScope } = require('./workspaceScope');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Raw lookup by id (no scope filter) — used only to decide whether a chat
// exists AND is accessible to the scoped caller (ownedInScope).
async function findChat(chatId) {
  if (typeof chatId !== 'string' || !chatId || chatId.length > 200) return null;
  const { data, error } = await supabase
    .from('chats')
    .select('*')
    .eq('id', chatId)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Is this chat accessible in the current scope? (always true when unscoped)
async function isChatAccessible(chatId) {
  const scope = currentScope();
  if (!scope) return true;
  return ownedInScope(await findChat(chatId), scope);
}

// Save new chat
async function saveChat(chatId, userId, title) {
  try {
    const { error } = await supabase
      .from('chats')
      .insert([{ id: chatId, user_id: userId, title, created_at: new Date().toISOString(), ...scopeFields() }]);
    if (error) throw error;
    console.log('Chat saved ✅');
  } catch (err) {
    console.error('Save chat error:', err.message);
  }
}

// Update chat title. Returns false when a scoped caller does not own the chat.
async function updateChatTitle(chatId, title) {
  try {
    const scope = currentScope();
    let q = supabase.from('chats').update({ title }).eq('id', chatId);
    if (scope) q = applyScope(q.eq('user_id', scope.userId), scope);
    // NOTE: PostgREST applies or() filters to the RETURNED row set of a
    // mutation, so every column used by applyScope must be selected.
    const { data, error } = await q.select('id, workspace_id');
    if (error) throw error;
    return !scope || (Array.isArray(data) && data.length > 0);
  } catch (err) {
    console.error('Update chat error:', err.message);
    return false;
  }
}

// Delete chat. Returns false when a scoped caller does not own the chat.
async function deleteChat(chatId) {
  try {
    const scope = currentScope();
    if (scope) {
      if (!(await isChatAccessible(chatId))) return false;
      await applyScope(supabase.from('conversations').delete()
        .eq('chat_id', chatId).eq('user_id', scope.userId), scope);
      await applyScope(supabase.from('chats').delete()
        .eq('id', chatId).eq('user_id', scope.userId), scope);
    } else {
      await supabase.from('conversations').delete().eq('chat_id', chatId);
      await supabase.from('chats').delete().eq('id', chatId);
    }
    console.log('Chat deleted ✅');
    return true;
  } catch (err) {
    console.error('Delete chat error:', err.message);
    return false;
  }
}

// Get all chats for user
async function getUserChats(userId) {
  try {
    const { data, error } = await applyScope(supabase
      .from('chats')
      .select('*')
      .eq('user_id', userId))
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
        created_at: new Date().toISOString(),
        ...scopeFields()
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
    const { data, error } = await applyScope(supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('chat_id', chatId))
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

module.exports = { saveChat, updateChatTitle, deleteChat, getUserChats, saveConversation, getHistory, findChat, isChatAccessible };
