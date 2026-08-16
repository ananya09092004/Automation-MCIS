// Detects the script/language of the transcribed command text, and gives
// back the fixed system phrases (Ji bolo, Ho gaya, etc.) in that language,
// so replies match whatever language the user spoke in.

const SCRIPT_RANGES = {
  hindi: /[\u0900-\u097F]/,       // Devanagari (Hindi, Marathi)
  tamil: /[\u0B80-\u0BFF]/,
  telugu: /[\u0C00-\u0C7F]/,
  bengali: /[\u0980-\u09FF]/,
  gujarati: /[\u0A80-\u0AFF]/,
  kannada: /[\u0C80-\u0CFF]/,
  malayalam: /[\u0D00-\u0D7F]/,
  punjabi: /[\u0A00-\u0A7F]/,
  urdu: /[\u0600-\u06FF]/
};

const HINGLISH_WORDS = ['hai', 'kya', 'kar', 'karo', 'nahi', 'mera', 'meri', 'kaise', 'bata', 'batao', 'accha', 'theek'];

const PHRASES = {
  hindi: {
    listening: 'जी बोलिए',
    done: 'हो गया',
    notUnderstood: 'कुछ समझ नहीं आया, दोबारा बोलिए',
    error: 'कुछ समस्या आ गई, दोबारा कोशिश करें',
    approvalNeeded: (msg) => `${msg} MCIS ऐप में मंज़ूरी दीजिए।`,
    ready: 'तैयार है, MCIS ऐप में देख लीजिए।'
  },
  hinglish: {
    listening: 'Ji bolo',
    done: 'Ho gaya',
    notUnderstood: 'Kuch samajh nahi aaya, dobara boliye',
    error: 'Kuch problem aa gayi, dobara try karo',
    approvalNeeded: (msg) => `${msg} MCIS app me approve kar dijiye.`,
    ready: 'Tayyar hai, MCIS app me dekh lijiye.'
  },
  english: {
    listening: 'Go ahead',
    done: 'Done',
    notUnderstood: "I didn't catch that, please say it again",
    error: 'Something went wrong, please try again',
    approvalNeeded: (msg) => `${msg} Please approve it in the MCIS app.`,
    ready: 'Ready — check the MCIS app.'
  },
  tamil: {
    listening: 'சொல்லுங்கள்',
    done: 'முடிந்தது',
    notUnderstood: 'புரியவில்லை, மீண்டும் சொல்லுங்கள்',
    error: 'சிக்கல் ஏற்பட்டது, மீண்டும் முயற்சிக்கவும்',
    approvalNeeded: (msg) => `${msg} MCIS ஆப்பில் அனுமதிக்கவும்.`,
    ready: 'தயார், MCIS ஆப்பில் பாருங்கள்.'
  },
  telugu: {
    listening: 'చెప్పండి',
    done: 'పూర్తయింది',
    notUnderstood: 'అర్థం కాలేదు, మళ్ళీ చెప్పండి',
    error: 'సమస్య వచ్చింది, మళ్ళీ ప్రయత్నించండి',
    approvalNeeded: (msg) => `${msg} MCIS యాప్‌లో ఆమోదించండి.`,
    ready: 'సిద్ధంగా ఉంది, MCIS యాప్‌లో చూడండి.'
  }
};

function detectLanguage(text) {
  for (const [lang, regex] of Object.entries(SCRIPT_RANGES)) {
    if (regex.test(text)) {
      if (PHRASES[lang]) return lang;
      return 'hindi';
    }
  }

  const lower = text.toLowerCase();
  const hinglishHits = HINGLISH_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
  if (hinglishHits >= 1) return 'hinglish';

  return 'english';
}

function getPhrases(text) {
  const lang = detectLanguage(text || '');
  return PHRASES[lang] || PHRASES.hinglish;
}

module.exports = { detectLanguage, getPhrases };