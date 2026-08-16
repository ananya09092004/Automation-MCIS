const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_HOST = process.env.PINECONE_HOST;

// Cohere embedding — 1024 dimensions
async function getCohereEmbedding(text) {
  try {
    const response = await axios.post(
      'https://api.cohere.com/v1/embed',
      {
        texts: [text],
        model: 'embed-multilingual-v3.0',
        input_type: 'search_document'
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
      console.log('PDF Cohere embedding ✅ length:', values.length);
      return values;
    }
    return null;
  } catch (err) {
    console.error('PDF Cohere embedding error:', err.response?.data || err.message);
    return null;
  }
}

// Pinecone embedding — fallback
async function getPineconeEmbedding(text) {
  try {
    const response = await axios.post(
      'https://api.pinecone.io/embed',
      {
        model: 'llama-text-embed-v2',
        inputs: [{ text }],
        parameters: { input_type: 'passage', truncate: 'END' }
      },
      {
        headers: {
          'Api-Key': PINECONE_API_KEY,
          'Content-Type': 'application/json',
          'X-Pinecone-API-Version': '2025-01'
        }
      }
    );
    return response.data?.data?.[0]?.values || null;
  } catch (err) {
    console.error('PDF Pinecone embedding error:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Main embedding — Cohere primary, Pinecone fallback
async function getEmbedding(text) {
  const cohereEmb = await getCohereEmbedding(text);
  if (cohereEmb) return cohereEmb;

  console.log('PDF: Cohere failed — using Pinecone fallback');
  return await getPineconeEmbedding(text);
}

// PDF chunks Supabase mein save karo
async function storePdfChunks(userId, fileName, chunks) {
  try {
    let saved = 0;
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];
      if (!text || text.trim().length < 20) continue;

      const embedding = await getEmbedding(text);
      if (!embedding) continue;

      const { error } = await supabase
        .from('pdf_vectors')
        .insert([{
          user_id: userId,
          file_name: fileName,
          chunk_index: i,
          content: text.slice(0, 1000),
          embedding: JSON.stringify(embedding),
          created_at: new Date().toISOString()
        }]);

      if (error) {
        console.error(`Chunk ${i} error:`, error.message);
      } else {
        saved++;
      }
    }
    console.log(`PDF stored ✅ — ${saved} chunks — ${fileName}`);
  } catch (err) {
    console.error('storePdfChunks error:', err.message);
  }
}

// PDF chunks search karo
async function searchPdfChunks(userId, question, fileName = null) {
  try {
    const embedding = await getEmbedding(question);
    if (!embedding) return '';

    const rpcName = fileName ? 'search_pdf_chunks_by_file' : 'search_pdf_chunks';
    const params = fileName
      ? { query_embedding: JSON.stringify(embedding), match_user_id: userId, match_file_name: fileName, match_count: 6 }
      : { query_embedding: JSON.stringify(embedding), match_user_id: userId, match_count: 6 };

    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) throw error;
    if (!data || !data.length) return '';

    const result = data
      .map(m => `[${m.file_name} — chunk ${m.chunk_index}]:\n${m.content}`)
      .join('\n\n');

    console.log(`PDF search: ${data.length} chunks found`);
    return result;
  } catch (err) {
    console.error('searchPdfChunks error:', err.message);
    return '';
  }
}

module.exports = { storePdfChunks, searchPdfChunks };