const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Layer 2: inside a workspace-scoped request, a memory is only visible /
// editable / deletable by its OWNER in the SAME workspace. (Previously
// DELETE/PATCH /:memoryId worked on any id, and deleting a memory removed
// every user's vectors with the same content.)
const { currentScope, applyScope } = require('../services/workspaceScope');
const MEMORY_NOT_FOUND = { success: false, error: 'Memory not found' };

function ownedMemoryQuery(query) {
  const scope = currentScope();
  if (!scope) return query;
  return applyScope(query.eq('user_id', scope.userId), scope);
}

// Get all memories for user
router.get('/:userId', async (req, res) => {
  try {
    const { data, error } = await applyScope(supabase
      .from('user_memories')
      .select('*')
      .eq('user_id', req.params.userId))
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, memories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a memory â€” user_memories + memory_vectors dono se
router.delete('/:memoryId', async (req, res) => {
  try {
    // user_memories se content lo
    const scope = currentScope();
    const { data: rows } = await ownedMemoryQuery(supabase
      .from('user_memories')
      .select('content, user_id')
      .eq('id', req.params.memoryId));
    const data = rows && rows[0];
    if (scope && !data) return res.status(404).json(MEMORY_NOT_FOUND);

    // user_memories se delete karo
    const { error } = await ownedMemoryQuery(supabase
      .from('user_memories')
      .delete()
      .eq('id', req.params.memoryId));

    if (error) throw error;

    // memory_vectors se bhi delete karo â€” same content match karke
    // (Layer 2: only the owner's vectors in this workspace)
    if (data?.content) {
      let vq = supabase
        .from('memory_vectors')
        .delete()
        .eq('content', data.content);
      vq = scope ? ownedMemoryQuery(vq) : (data.user_id ? vq.eq('user_id', data.user_id) : vq);
      await vq;
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update a memory
router.patch('/:memoryId', async (req, res) => {
  try {
    const { content } = req.body;

    const { data: updated, error } = await ownedMemoryQuery(supabase
      .from('user_memories')
      .update({ content })
      .eq('id', req.params.memoryId))
      .select('id, workspace_id'); // or() filters need their columns in the returned set

    if (error) throw error;
    if (currentScope() && !(updated && updated.length)) return res.status(404).json(MEMORY_NOT_FOUND);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Natural language memory delete
router.post('/nl-delete/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { query } = req.body;

    // Saari memories fetch karo
    const { data: memories, error } = await applyScope(supabase
      .from('user_memories')
      .select('*')
      .eq('user_id', userId));

    if (error) throw error;
    if (!memories?.length) return res.json({ success: true, deleted: 0 });

    // Groq se match karwao
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{
        role: 'user',
        content: `User wants to delete: "${query}"

Here are their memories (as JSON array):
${JSON.stringify(memories.map(m => ({ id: m.id, content: m.content })))}

Return ONLY a JSON array of IDs that match what user wants to delete.
Example: [1, 2, 3]
If nothing matches, return: []
No explanation, just the JSON array.`
      }],
      max_tokens: 200,
      temperature: 0
    });

    const text = completion.choices[0].message.content.trim();
    const idsToDelete = JSON.parse(text);

    if (!idsToDelete.length) {
      return res.json({ success: true, deleted: 0, message: 'No matching memories found' });
    }

    // Delete hone wali memories ka content lo
    // Layer 2: only ids that were actually in THIS user's (scoped) list —
    // the model's output is never trusted to name other rows.
    const toDelete = memories.filter(m => idsToDelete.includes(m.id));
    const safeIds = toDelete.map(m => m.id);
    const contentsToDelete = toDelete.map(m => m.content);
    if (!safeIds.length) {
      return res.json({ success: true, deleted: 0, message: 'No matching memories found' });
    }

    // user_memories se delete karo
    const { error: delError } = await applyScope(supabase
      .from('user_memories')
      .delete()
      .eq('user_id', userId)
      .in('id', safeIds));

    if (delError) throw delError;

    // memory_vectors se bhi delete karo
    if (contentsToDelete.length > 0) {
      await applyScope(supabase
        .from('memory_vectors')
        .delete()
        .eq('user_id', userId)
        .in('content', contentsToDelete));
    }

    res.json({ success: true, deleted: safeIds.length });
  } catch (err) {
    console.error('NL delete error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;