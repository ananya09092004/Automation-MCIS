const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_HOST = process.env.PINECONE_HOST;

// ✅ FIX: Cohere's embed-multilingual-v3.0 is an ASYMMETRIC model — it deliberately
// encodes queries and stored documents differently to improve retrieval quality.
// Previously input_type was hardcoded to 'search_document' for BOTH saving and
// searching, which silently hurt match quality (queries weren't encoded as queries).
// Now saveMemory() passes 'document' and searchMemory() passes 'query'.

// FIX: an invalid/missing Cohere key was costing every single save/search a
// full failed HTTP round-trip (+ a console.error) before falling back to
// Pinecone — same pattern as the digital_twin_model fix. Once we see an
// auth-style failure (401/invalid key), stop trying Cohere for the rest of
// this process's lifetime and go straight to Pinecone. Fix the real key in
// .env and restart the server to re-enable Cohere.
let cohereDisabled = !COHERE_API_KEY; // also skip immediately if no key configured at all

function isCohereAuthError(err) {
  const status = err?.response?.status;
  const message = (err?.response?.data?.message || err?.message || '').toLowerCase();
  return status === 401 || message.includes('invalid api key') || message.includes('incorrect api key');
}

// Cohere embedding — 1024 dimensions
async function getCohereEmbedding(text, mode = 'document') {
  if (cohereDisabled) return null; // fast path — known-bad key, don't retry every request

  try {
    const inputType = mode === 'query' ? 'search_query' : 'search_document';
    const response = await axios.post(
      'https://api.cohere.com/v1/embed',
      {
        texts: [text],
        model: 'embed-multilingual-v3.0',
        input_type: inputType
      },
      {
        headers: {
          'Authorization': `Bearer ${COHERE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    const values = response.data?.embeddings?.[0];
    if (values && values.length > 0) {
      console.log('Cohere embedding ✅ length:', values.length, '| mode:', mode);
      return values;
    }
    return null;
  } catch (err) {
    if (isCohereAuthError(err)) {
      cohereDisabled = true;
      console.warn('Cohere API key invalid — disabling Cohere for this session, using Pinecone only. Fix COHERE_API_KEY in .env and restart to re-enable.');
      return null;
    }
    console.error('Cohere embedding error:', err.response?.data || err.message);
    return null;
  }
}

// Pinecone embedding — fallback
async function getPineconeEmbedding(text, mode = 'document') {
  try {
    const inputType = mode === 'query' ? 'query' : 'passage';
    const response = await axios.post(
      'https://api.pinecone.io/embed',
      {
        model: 'llama-text-embed-v2',
        inputs: [{ text }],
        parameters: { input_type: inputType, truncate: 'END' }
      },
      {
        headers: {
          'Api-Key': PINECONE_API_KEY,
          'Content-Type': 'application/json',
          'X-Pinecone-API-Version': '2025-01'
        }
      }
    );
    const values = response.data?.data?.[0]?.values;
    if (values) {
      console.log('Pinecone embedding ✅ length:', values.length, '| mode:', mode);
      return values;
    }
    return null;
  } catch (err) {
    console.error('Pinecone embedding error:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Main embedding — Cohere primary, Pinecone fallback
// mode: 'document' when saving/storing content, 'query' when searching
async function getEmbedding(text, mode = 'document') {
  const cohereEmb = await getCohereEmbedding(text, mode);
  if (cohereEmb) return cohereEmb;

  if (!cohereDisabled) console.log('Cohere failed — using Pinecone fallback');
  const pineconeEmb = await getPineconeEmbedding(text, mode);
  if (pineconeEmb) return pineconeEmb;

  console.error('Both embeddings failed');
  return null;
}

// Supabase mein memory save karo
async function saveMemory(userId, text) {
  try {
    const embedding = await getEmbedding(text, 'document'); // ✅ storing content
    if (!embedding) {
      console.log('Embedding failed — memory not saved');
      return;
    }

    const { error } = await supabase
      .from('memory_vectors')
      .insert([{
        user_id: userId,
        content: text,
        embedding: JSON.stringify(embedding),
        created_at: new Date().toISOString()
      }]);

    if (error) throw error;
    console.log('Memory saved ✅:', text.slice(0, 50));
  } catch (err) {
    console.error('Save memory error:', err.message);
  }
}

// Supabase mein memory search karo
// ✅ FIX: previously this discarded the vector similarity score entirely
// (`data.map(m => m.content)`) and always returned the top 8 nearest
// vectors no matter how weak the match was — a memory about "transport"
// could be returned for a "wildlife" query if nothing closer existed.
// Now: similarity is preserved, and a `similarityThreshold` can be passed
// to actually reject weak matches. This applies to EVERY query type
// (personal, project, factual, coding, general) — it's not domain-specific.
//
// `raw=true` returns [{ content, similarity }, ...] for callers (like
// memoryManager.js) that need to filter/rank on real similarity.
// `raw=false` (default) returns a joined string for backward compatibility
// with any older caller that just wants text.
async function searchMemory(userId, query, { similarityThreshold = 0, raw = false } = {}) {
  try {
    const embedding = await getEmbedding(query, 'query'); // ✅ searching — correct mode now
    if (!embedding) return raw ? [] : '';

    const { data, error } = await supabase.rpc('search_memories', {
      query_embedding: JSON.stringify(embedding),
      match_user_id: userId,
      match_count: 8
    });

    if (error) throw error;
    if (!data || !data.length) return raw ? [] : '';

    // `similarity` is the conventional column name for pgvector match
    // functions. If the RPC doesn't return it, fall back to 1 (no filtering
    // possible) rather than silently dropping every result.
    const results = data
      .map(m => ({
        content: m.content,
        similarity: typeof m.similarity === 'number' ? m.similarity : 1,
      }))
      .filter(m => m.similarity >= similarityThreshold);

    if (raw) return results;
    return results.map(m => m.content).join('\n');
  } catch (err) {
    console.error('Search memory error:', err.message);
    return raw ? [] : '';
  }
}

module.exports = { saveMemory, searchMemory };