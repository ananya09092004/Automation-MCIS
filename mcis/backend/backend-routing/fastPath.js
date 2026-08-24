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

// Common websites with fixed, unambiguous URLs — skip Gemini entirely for
// these, same speed benefit as the desktop-app fast-path above.
const KNOWN_WEBSITES = {
  'gmail': 'https://mail.google.com',
  'google': 'https://google.com',
  'youtube': 'https://youtube.com',
  'amazon': 'https://amazon.in',
  'facebook': 'https://facebook.com',
  'instagram': 'https://instagram.com',
  'twitter': 'https://twitter.com',
  'x': 'https://x.com',
  'linkedin': 'https://linkedin.com',
  'whatsapp': 'https://web.whatsapp.com',
  'github': 'https://github.com',
  'netflix': 'https://netflix.com',
  'maps': 'https://maps.google.com',
  'google maps': 'https://maps.google.com',
  'drive': 'https://drive.google.com',
  'google drive': 'https://drive.google.com',
};

const OPEN_PATTERNS = [
  /^(?:hey nexus,?\s*)?(?:please\s*)?open\s+(.+?)(?:\s+please)?$/i,
  /^(.+?)\s*khol(?:o|do)$/i,
  /^(.+?)\s*chalu\s*karo$/i,
];

const CLOSE_PATTERNS = [
  /^(?:hey nexus,?\s*)?(?:please\s*)?close\s+(.+?)(?:\s+please)?$/i,
  /^(.+?)\s*band\s*kar(?:o|do)$/i,
];

function extractTarget(text, patterns) {
  const trimmed = text.trim();
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return match[1].trim().toLowerCase();
    }
  }
  return null;
}

function tryFastPath(message) {
  const openTarget = extractTarget(message, OPEN_PATTERNS);
  if (openTarget) {
    if (KNOWN_DESKTOP_APPS.includes(openTarget)) {
      return { action: 'open_app', payload: { platform: 'desktop', parameters: { app: openTarget }, target: {}, value: null } };
    }
    if (KNOWN_WEBSITES[openTarget]) {
      return { action: 'navigate', payload: { platform: 'browser', parameters: { url: KNOWN_WEBSITES[openTarget] }, target: {}, value: KNOWN_WEBSITES[openTarget] } };
    }
  }

  const closeTarget = extractTarget(message, CLOSE_PATTERNS);
  if (closeTarget && KNOWN_DESKTOP_APPS.includes(closeTarget)) {
    return { action: 'close_app', payload: { platform: 'desktop', parameters: { app: closeTarget }, target: {}, value: null } };
  }

  return null; // no match — caller falls back to Gemini
}

module.exports = { tryFastPath };
