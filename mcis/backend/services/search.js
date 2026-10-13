const axios = require('axios');

async function webSearch(query) {
  try {
    const response = await axios.post('https://google.serper.dev/search', 
      { q: query, num: 5 },
      { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' } }
    );

    const results = response.data.organic || [];
    return results.slice(0, 5).map(r => `Title: ${r.title}\nSnippet: ${r.snippet}\nLink: ${r.link}`).join('\n\n');
  } catch (err) {
    console.error('Search error:', err.message);
    return '';
  }
}

function needsSearch(message) {
  const searchKeywords = [
    'today', 'aaj', 'news', 'score', 'price', 'weather', 'mausam',
    'current', 'latest', 'abhi', 'kya chal raha', 'live', 'result',
    'who is', 'kaun hai', '2024', '2025', '2026', 'stock', 'rate'
  ];
  const lower = message.toLowerCase();
  return searchKeywords.some(k => lower.includes(k));
}

module.exports = { webSearch, needsSearch };