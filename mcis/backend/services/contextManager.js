/*
  REASON: Context Manager — AI ko hamesha 
  relevant context mile
  Long conversations mein bhi confused na ho
  Token limit manage kare
*/

// History ko smart compress karo
function compressHistory(history, maxMessages = 10) {
  if (!history || history.length === 0) return [];

  // Sirf last N messages lo
  // Reason: Bahut purani history AI ko confuse karti hai
  const recent = history.slice(-maxMessages);

  return recent.flatMap(h => ([
    { role: 'user', content: h.message.slice(0, 500) },
    { role: 'assistant', content: h.response.slice(0, 500) }
  ]));
}

// Context window calculate karo
function calculateContextSize(messages) {
  return messages.reduce((total, msg) => {
    return total + (msg.content?.length || 0);
  }, 0);
}

// Smart context build karo
function buildSmartContext({
  memoryContext = '',
  profileContext = '',
  intelligenceContext = '',
  searchContext = '',
  fileContext = ''
}) {
  const parts = [];

  // Profile sabse pehle — most important
  if (profileContext) {
    parts.push(`USER PROFILE:\n${profileContext}`);
  }

  // Intelligence — how to talk
  if (intelligenceContext) {
    parts.push(intelligenceContext);
  }

  // Memory — what user told before
  if (memoryContext) {
    parts.push(`MEMORY FROM PAST CONVERSATIONS:\n${memoryContext}`);
  }

  // Search results — real time data
  if (searchContext) {
    parts.push(`REAL-TIME WEB SEARCH RESULTS:\n${searchContext}`);
  }

  // File content
  if (fileContext) {
    parts.push(`UPLOADED FILE CONTENT:\n${fileContext}`);
  }

  return parts.join('\n\n---\n\n');
}

module.exports = { compressHistory, buildSmartContext, calculateContextSize };