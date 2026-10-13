const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

async function ask(prompt) {
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function draftEmail({ to, purpose, tone = 'professional', context = '' }) {
  return ask(`Write a ${tone} email to ${to} about: ${purpose}. Context: ${context}. Return only the email body.`);
}

async function customizeResume({ resumeText, jobDescription }) {
  return ask(`Given this resume:\n${resumeText}\n\nAnd this job description:\n${jobDescription}\n\nSuggest specific edits to tailor the resume. List concrete changes.`);
}

async function research({ topic, depth = 'summary' }) {
  return ask(`Research and explain "${topic}" at a ${depth} level. Be accurate, note if info may be outdated.`);
}

async function generateCode({ description, language }) {
  return ask(`Write ${language} code for: ${description}. Return only code with minimal comments.`);
}

async function fixBug({ code, errorMessage, language }) {
  return ask(`This ${language} code has a bug:\n${code}\n\nError:\n${errorMessage}\n\nExplain briefly and provide fixed code.`);
}

async function summarizeMeeting({ transcript }) {
  return ask(`Summarize this meeting transcript into: key decisions, action items (with owners if mentioned), open questions.\n\n${transcript}`);
}

async function takeNotes({ rawText }) {
  return ask(`Convert this rough text into clean, organized notes with headers and bullet points:\n\n${rawText}`);
}

async function translate({ text, targetLanguage }) {
  return ask(`Translate this text to ${targetLanguage}, preserving tone and meaning:\n\n${text}`);
}

module.exports = { draftEmail, customizeResume, research, generateCode, fixBug, summarizeMeeting, takeNotes, translate };
