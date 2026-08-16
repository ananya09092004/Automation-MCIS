const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// TODO: move to Supabase table (user_google_tokens) instead of in-memory.
const userTokens = new Map();

function getAuthUrl(userId) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: userId
  });
}

async function handleOAuthCallback(code, userId) {
  const { tokens } = await oauth2Client.getToken(code);
  userTokens.set(userId, tokens);
  return { success: true, connected: true };
}

function getClientForUser(userId) {
  const tokens = userTokens.get(userId);
  if (!tokens) throw new Error('User has not connected Google Calendar yet');
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  client.setCredentials(tokens);
  return client;
}

async function createEvent(userId, { title, startTime, endTime, description }) {
  const client = getClientForUser(userId);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const event = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: { summary: title, description, start: { dateTime: startTime }, end: { dateTime: endTime } }
  });
  return { success: true, eventId: event.data.id, link: event.data.htmlLink };
}

async function listUpcomingEvents(userId, maxResults = 10) {
  const client = getClientForUser(userId);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.list({
    calendarId: 'primary', timeMin: new Date().toISOString(), maxResults, singleEvents: true, orderBy: 'startTime'
  });
  return res.data.items.map((e) => ({ title: e.summary, start: e.start.dateTime || e.start.date, link: e.htmlLink }));
}

module.exports = { getAuthUrl, handleOAuthCallback, createEvent, listUpcomingEvents };
