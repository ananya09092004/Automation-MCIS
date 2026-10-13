// Lightweight fast-path for the most common, UNAMBIGUOUS desktop apps,
// websites, and web searches -- skips Gemini classification entirely
// for these, since they're unambiguous and don't need an LLM to
// interpret. Anything not matched here falls through to Gemini as
// before -- this file only ever adds a shortcut, never removes the
// normal path.
//
// open_app() does its own dynamic discovery of whether an app is
// actually installed (desktop/app_controller/controller.py) and fails
// gracefully (not a crash) if it isn't -- so it's safe to list a broad
// set of common app names here even though not everyone has every app
// installed. A listed-but-not-installed app just reports "couldn't do
// that", same as today.

const KNOWN_DESKTOP_APPS = [
  // Core Windows apps
  'notepad', 'calculator', 'paint', 'file explorer', 'explorer',
  'cmd', 'command prompt', 'task manager', 'wordpad', 'control panel',
  'settings', 'terminal', 'powershell', 'windows powershell',
  'registry editor', 'regedit', 'device manager', 'disk management',
  'event viewer', 'services', 'system information', 'resource monitor',
  'task scheduler', 'magnifier', 'character map', 'disk cleanup',
  'remote desktop', 'remote desktop connection', 'snipping tool',
  'snip and sketch', 'media player', 'windows media player', 'photos',
  'camera', 'voice recorder', 'sound recorder', 'sticky notes',
  'calendar', 'mail', 'onedrive',

  // Microsoft Office
  'word', 'excel', 'powerpoint', 'outlook', 'onenote', 'teams',
  'microsoft teams', 'access', 'publisher',

  // Browsers
  'chrome', 'edge', 'firefox', 'opera', 'brave',

  // Communication
  'discord', 'slack', 'zoom', 'skype', 'telegram', 'whatsapp desktop',

  // Media / creative
  'spotify', 'vlc', 'vlc media player', 'obs', 'obs studio',
  'photoshop', 'adobe photoshop', 'acrobat', 'adobe acrobat',
  'adobe reader',

  // Dev tools
  'vs code', 'vscode', 'visual studio', 'visual studio code',
  'android studio', 'postman', 'docker desktop', 'git bash',

  // Utilities
  '7zip', '7-zip', 'winrar', 'notion', 'steam',
];

// Common websites with fixed, unambiguous URLs -- skip Gemini entirely
// for these, same speed benefit as the desktop-app fast-path above.
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
      // STT engines (especially Whisper) often return proper punctuation
      // ("Open Gmail." instead of "open gmail") -- strip any trailing
      // punctuation before the dictionary lookup below, otherwise
      // "gmail." != "gmail" and this silently falls through to Gemini
      // even though it's an exact, unambiguous match.
      return match[1].trim().toLowerCase().replace(/[.,!?]+$/, '').trim();
    }
  }
  return null;
}

function buildSearchUrl(site, rawQuery) {
  const query = (rawQuery || '').trim().replace(/[.,!?]+$/, '').trim();
  if (!query) return null;
  const encoded = encodeURIComponent(query);
  if (site === 'youtube') {
    return `https://www.youtube.com/results?search_query=${encoded}`;
  }
  return `https://www.google.com/search?q=${encoded}`;
}

// "search for X on youtube/google", "google X", "youtube X",
// "search [for] X" (defaults to Google when no site is named).
function trySearchFastPath(message) {
  const trimmed = message.trim();

  let match = trimmed.match(/^(?:hey nexus,?\s*)?(?:please\s*)?search\s+(?:for\s+)?(.+?)\s+on\s+(google|youtube)\s*[.!?]*$/i);
  if (match) {
    return buildSearchUrl(match[2].toLowerCase(), match[1]);
  }

  match = trimmed.match(/^google\s+(.+?)\s*[.!?]*$/i);
  if (match) {
    return buildSearchUrl('google', match[1]);
  }

  match = trimmed.match(/^youtube\s+(.+?)\s*[.!?]*$/i);
  if (match) {
    return buildSearchUrl('youtube', match[1]);
  }

  match = trimmed.match(/^(?:hey nexus,?\s*)?(?:please\s*)?search\s+(?:for\s+)?(.+?)\s*[.!?]*$/i);
  if (match) {
    return buildSearchUrl('google', match[1]);
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

  const searchUrl = trySearchFastPath(message);
  if (searchUrl) {
    return { action: 'navigate', payload: { platform: 'browser', parameters: { url: searchUrl }, target: {}, value: searchUrl } };
  }

  return null; // no match -- caller falls back to Gemini
}

module.exports = { tryFastPath };