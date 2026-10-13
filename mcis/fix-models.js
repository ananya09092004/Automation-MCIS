// fix-models.js
// Run this ONCE from your project root: node fix-models.js
// It bulk-replaces the deprecated model with a live one, adding the
// required 'reasoning: none' param so Qwen3.6 behaves like a normal
// chat model (final answer goes straight into message.content).

const fs = require('fs');
const path = require('path');

const files = [
  'backend/routes/chat.js',
  'backend/routes/goals.js',
  'backend/routes/memory.js',
  'backend/routes/timeline.js',
  'backend/services/adaptationEngineService.js',
  'backend/services/adversarialTestService.js',
  'backend/services/algorithmDetectionService.js',
  'backend/services/behaviorPredictionService.js',
  'backend/services/complexityAnalysisService.js',
  'backend/services/dailyPlanService.js',
  'backend/services/decisionRecommenderService.js',
  'backend/services/digitalTwinService.js',
  'backend/services/executionMemory.js',
  'backend/services/futureSimulatorService.js',
  'backend/services/goalBreakdownService.js',
  'backend/services/mlPredictor.js',
  'backend/services/multiFileService.js',
  'backend/services/plannerService.js',
  'backend/services/proactiveService.js',
  'backend/services/recommendationEngine.js',
  'backend/services/sandboxService.js',
  'backend/services/suggestionManager.js',
  'backend/services/summaryManager.js',
  'backend/services/surgicalRepairService.js',
  'backend/services/syntaxVerificationService.js',
  'backend/services/trajectoryPredictorService.js',
  'backend/services/twinAdaptationService.js',
  'backend/services/twinLearningService.js',
];

// Matches:  model: 'llama-3.3-70b-versatile',   (any amount of spacing after the colon)
const pattern = /^([ \t]*)model:\s*'llama-3\.3-70b-versatile',[ \t]*$/gm;

let totalChanges = 0;
let filesChanged = 0;

for (const relPath of files) {
  const filePath = path.join(__dirname, relPath);

  if (!fs.existsSync(filePath)) {
    console.warn(`SKIP (file not found): ${relPath}`);
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let count = 0;

  const updated = content.replace(pattern, (match, indent) => {
    count++;
    return `${indent}model: 'qwen/qwen3.6-27b',\n${indent}reasoning_effort: 'none',`;
  });

  if (count > 0) {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log(`OK: ${relPath} - ${count} replacement(s)`);
    totalChanges += count;
    filesChanged++;
  } else {
    console.log(`WARN: ${relPath} - pattern NOT matched, check this file manually`);
  }
}

console.log(`\n=== Done ===`);
console.log(`Files changed: ${filesChanged}/${files.length}`);
console.log(`Total model replacements: ${totalChanges}`);
console.log(`\nNext: review a git diff, then commit + push.`);
