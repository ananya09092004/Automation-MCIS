// Lightweight fast-path for the most common, UNAMBIGUOUS desktop apps only.
// We use a whitelist (not a broad regex) so words like "gmail", "amazon",
// "youtube" — which are websites, not desktop apps — always fall through to
// Gemini, which correctly routes them to a browser "navigate" action instead.

const KNOWN_DESKTOP_APPS = [
  'notepad', 'calculator', 'paint', 'file explorer', 'explorer',
  'cmd', 'command prompt', 'task manager', 'wordpad', 'control panel',
  'settings', 'word', 'excel', 'powerpoint', 'vs code', 'vscode',
  'chrome', 'edge', 'firefox', 'spotify', 'terminal',
];

const OPEN_PATTERNS = [
  /^(?:hey nexus,?\s*)?(?:please\s*)?open\s+(.+?)(?:\s+please)?$/i,
  /^(.+?)\s*khol(?:o|do)$/i,
  /^(.+?)\s*chalu\s*karo$/i,
];

const CLOSE_PATTERNS = [
  /^(?:hey nexus,?\s*)?(?:please\s*)?close\s+(.+?)(?:\s+please)?$/i,
  /^(.+?)\s*band\s*kar(?:o|do)$/i,
];

function extractApp(text, patterns) {
  const trimmed = text.trim();
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const app = match[1].trim().toLowerCase();
      // Only fast-path if it's an exact match to a known desktop app —
      // anything else (websites, ambiguous names, multi-word phrases)
      // falls through to Gemini for proper classification.
      if (KNOWN_DESKTOP_APPS.includes(app)) {
        return app;
      }
    }
  }
  return null;
}

function tryFastPath(message) {
  const openApp = extractApp(message, OPEN_PATTERNS);
  if (openApp) {
    return { action: 'open_app', payload: { platform: 'desktop', parameters: { app: openApp }, target: {}, value: null } };
  }

  const closeApp = extractApp(message, CLOSE_PATTERNS);
  if (closeApp) {
    return { action: 'close_app', payload: { platform: 'desktop', parameters: { app: closeApp }, target: {}, value: null } };
  }

  return null; // no match — caller falls back to Gemini
}

module.exports = { tryFastPath };