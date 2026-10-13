const { saveMemory, searchMemory } = require('../services/memory');

async function logAction(userId, action, payload, result) {
  const success = !!(result && result.success);
  const summary = `User ran automation action "${action}" with ${JSON.stringify(payload)} — ${success ? 'succeeded' : 'failed'}.`;

  // fire-and-forget so a memory write never blocks the command response
  saveMemory(userId, summary).catch((err) =>
    console.error('Memory save failed for automation action:', err.message)
  );
}

async function getRelevantPastActions(userId, queryText) {
  return searchMemory(userId, queryText, { similarityThreshold: 0.5 });
}

module.exports = { logAction, getRelevantPastActions };
