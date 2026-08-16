const { generateContent } = require('./geminiClient');
// Nexus's full action vocabulary (see nexus/docs/09_supported_actions.md).
// These are routed straight to Nexus — action names match exactly, no mapping needed.
const NEXUS_DESKTOP_ACTIONS = [
  'open_app', 'close_app', 'restart_app', 'focus_app', 'minimize_app', 'maximize_app', 'switch_to_app', 'get_running_apps',
  'create_file', 'read_file', 'write_file', 'rename_file', 'copy_file', 'move_file', 'delete_file', 'search_file', 'verify_path',
  'create_folder', 'rename_folder', 'copy_folder', 'move_folder', 'delete_folder', 'search_folder', 'list_folder',
  'open_path', 'reveal_file', 'open_file', 'list_items', 'search_items',
  'move_mouse', 'click', 'double_click', 'right_click', 'drag_mouse', 'scroll_up', 'scroll_down', 'mouse_position',
  'type_text', 'press_key', 'hotkey', 'select_all', 'copy_selection', 'paste_selection', 'cut_selection', 'copy_text', 'paste_text', 'get_clipboard', 'clear_clipboard', 'cut_clipboard',
  'focus_window', 'minimize_window', 'maximize_window', 'close_window', 'window_exists', 'active_window', 'start_process', 'kill_process', 'restart_process', 'list_processes',
  'inspect_window', 'click_target', 'fill_target', 'read_target', 'target_exists', 'wait_for_target', 'inspect_screen_state',
  'capture_screen', 'capture_active_window', 'notify', 'read_notifications', 'clear_notifications', 'run_terminal',
  'create_word_document', 'read_word_document', 'create_excel_workbook', 'read_excel_rows', 'create_powerpoint_presentation', 'inspect_powerpoint_presentation', 'open_office_document',
];


const NEXUS_BROWSER_ACTIONS = [
  'navigate', 'back', 'forward', 'refresh', 'new_tab', 'switch_tab', 'close_tab', 'wait_for',
  'inspect_page', 'inspect_page_state', 'read_text', 'read_tables',
  'click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck',
  'next_page', 'previous_page', 'infinite_scroll', 'dismiss_safe_popup',
  'upload', 'download', 'save_session', 'load_session',
  'fill_form', 'login',
];

const NEXUS_ACTIONS = [...new Set([...NEXUS_DESKTOP_ACTIONS, ...NEXUS_BROWSER_ACTIONS])];
const GOAL_ACTIONS = ['run_goal'];
// MCIS-native actions (not part of Nexus — handled by AI task / productivity handlers)
const MCIS_NATIVE_ACTIONS = [
  'draftEmail', 'customizeResume', 'research', 'generateCode', 'fixBug',
  'summarizeMeeting', 'takeNotes', 'translate',
  'addReminder', 'addTodo', 'completeTodo', 'getDailyBriefing',
  'createCalendarEvent', 'listUpcomingEvents',
];

const KNOWN_ACTIONS = [...NEXUS_ACTIONS, ...MCIS_NATIVE_ACTIONS, ...GOAL_ACTIONS];
const SYSTEM_PROMPT = `You are MCIS's intent classifier. Given a user message, decide if it is:
- "chat": a question or conversation, no laptop action needed
- "action": user wants something done on their laptop, in a browser, or via MCIS automation

If "action", classify further into one of two shapes:

1. NEXUS ACTIONS — desktop control (apps, files, folders, mouse, keyboard, windows, office docs) or
   browser control (navigate, click, fill forms, read pages). Use this whenever the user wants
   something done ON the laptop or IN a browser — including multi-step goals like "order X online"
   or "draft and send an email in Gmail" (break these into the FIRST concrete step; MCIS will ask
   again for the next step after seeing the result).

   IMPORTANT distinction: if the user wants to OPEN/LAUNCH their email (e.g. "email kholo", "open
   my email", "open gmail", "mera email account kholo"), classify as a NEXUS action — use
   "open_app" with parameters {appName: "..."} for a desktop client (Outlook), or "navigate" with
   parameters {url: "https://mail.google.com"} for a browser. Only classify as the MCIS native
   "draftEmail" action (below) if the user explicitly wants an email DRAFTED/WRITTEN/COMPOSED
   (e.g. "email likh do", "draft an email to...", "compose an email"). The single word "email" by
   itself, with no verb, should default to opening it (NEXUS "navigate" to gmail.com), not drafting.

   Valid nexus actions: ${NEXUS_ACTIONS.join(', ')}

   Payload shape for nexus actions:
   {
     "type": "action",
     "action": "<nexus action name>",
     "payload": {
       "platform": "desktop" | "browser",
       "parameters": { ... action-specific inputs, e.g. path, url, text, timeout },
       "target": { ... UI target: window_title/app/name/automation_id for desktop,
                    or selector/role/name/label/text for browser },
       "value": "<primary value if any, e.g. text to type or fill>"
     }
   }
2. MULTI-STEP GOALS — if the request needs SEVERAL different actions chained together to
   complete (e.g. "order X online", "book a cab", "fill and submit this form", "email X and
   also add a reminder") — classify as action "run_goal" with payload { "goal": "<the user's
   full original request, verbatim>" }. Do NOT try to break it into steps yourself; the task
   planner will do that.

3. MCIS NATIVE ACTIONS — AI/productivity tasks not related to controlling the laptop directly:
   ${MCIS_NATIVE_ACTIONS.join(', ')}

   Payload shape for these matches their existing specific fields (to, purpose, tone, context for
   draftEmail; text, dueAt for addReminder; etc. — use your best judgment based on the action name).

Respond ONLY with JSON, no markdown, no explanation:
{ "type": "chat" | "action", "action": "<actionType or null>", "payload": {} }`;

async function classifyIntent(userMessage) {
  let result;
  try {
    const prompt = `${SYSTEM_PROMPT}\n\nUser message: "${userMessage}"`;
    result = await generateContent(prompt);
  } catch (err) {
    // Gemini quota/rate-limit/network failure — degrade gracefully instead
    // of throwing a raw stack trace back to the user.
    const isQuota = err.message && err.message.includes('429');
    return {
      type: 'chat',
      action: null,
      payload: {},
      message: isQuota
        ? 'AI system abhi busy hai (quota limit), thodi der baad try karo.'
        : 'AI system se connect nahi ho paya, dobara try karo.',
    };
  }

  const text = result.response.text().trim().replace(/```json|```/g, '');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { type: 'chat', action: null, payload: {} };
  }

  if (parsed.type === 'action' && !KNOWN_ACTIONS.includes(parsed.action)) {
    return { type: 'chat', action: null, payload: {} };
  }

  return parsed;
}

module.exports = { classifyIntent, NEXUS_ACTIONS, MCIS_NATIVE_ACTIONS };