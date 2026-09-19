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

// Internal safety constraint (not user-facing, not a phrase dictionary):
// which actions are safe to silently repeat when the user says "do that
// again"/"same thing" and lastAction refers to one of these. Read-only /
// navigation / view-state actions are safe -- repeating them changes
// nothing new. Anything that writes, submits, sends, deletes, or pays is
// deliberately excluded; for those, the classifier asks for confirmation
// instead of guessing that a blind repeat is safe (see SYSTEM_PROMPT).
const SAFE_TO_REPEAT_ACTIONS = [
  'open_app', 'focus_app', 'switch_to_app', 'minimize_app', 'maximize_app', 'get_running_apps',
  'read_file', 'search_file', 'verify_path', 'list_folder', 'search_folder',
  'open_path', 'reveal_file', 'open_file', 'list_items', 'search_items',
  'focus_window', 'minimize_window', 'maximize_window', 'window_exists', 'active_window', 'list_processes',
  'inspect_window', 'read_target', 'target_exists', 'inspect_screen_state', 'capture_screen', 'capture_active_window',
  'read_notifications', 'navigate', 'back', 'forward', 'refresh', 'new_tab', 'switch_tab',
  'inspect_page', 'inspect_page_state', 'read_text', 'read_tables', 'hover',
  'next_page', 'previous_page', 'read_word_document', 'read_excel_rows', 'inspect_powerpoint_presentation',
];

const SYSTEM_PROMPT = `You are MCIS's intent classifier. Given a user message, decide if it is:
- "chat": a question or conversation, no laptop action needed
- "action": user wants something done on their laptop, in a browser, or via MCIS automation
- "clarify": the request is clearly actionable, but WHO/WHAT it targets cannot be reliably
  determined from the message plus the given context -- see AMBIGUITY below

SEMANTIC MATCHING — READ THIS FIRST: users never learn or memorize exact
Nexus phrasing. They speak naturally — one word, a full sentence, an
indirect request, a synonym, a different word order, Hinglish, whatever
comes to mind. Your job is to recognize the underlying MEANING and map
it to the closest matching action below, not to pattern-match specific
wording. All of the following mean the exact same thing and MUST
classify to the same action + payload: "new tab", "open another tab",
"I need a fresh tab", "give me one more tab", "ek aur tab khol do". The
same principle applies to every other action — open/switch/focus/close/
minimize/maximize/restore an app or window, start a new document/file,
copy/paste, navigate somewhere, etc. — regardless of how indirectly or
conversationally it's phrased. If the request clearly wants SOMETHING
done (even if you have to infer which specific action), prefer picking
the closest matching action over "chat" — only use "chat" when the
message is genuinely a question/conversation with no actionable intent
at all. Example: "I need a blank document in Notepad" / "start
something new in Notepad" / "make a new file in Notepad" all mean:
Notepad should end up with a blank/new document open — if Notepad isn't
running, that's "open_app"; if it's already running, that's "hotkey"
with ctrl+n (Notepad's new-document shortcut) targeting the Notepad
window. Reason about the actual outcome the user wants, not the words
they used to describe it. IMPORTANT: never use "create_file" for this —
create_file only silently writes an empty file to disk, it does NOT
open or display anything, so it's the wrong action whenever the user
wants to actually SEE/use a new document, not just have a file exist.

"NEW WINDOW" (any app, including a browser) works the same way as "new
document" above, and by the same reasoning applies to ANY phrasing —
"open another Chrome window", "I need a fresh window", "start a new
VS Code window", etc.: if the app isn't running, "open_app" already
gives a fresh window on its own. If it's already running, use "hotkey"
with ctrl+n targeting that app's window (this is the real OS-level
new-window shortcut for the vast majority of Windows apps, including
Chrome, Notepad, VS Code, and Explorer) — there is no separate
"new_window" action name, so don't invent one; hotkey ctrl+n is the
correct mechanism. This is different from "new tab", which for a
browser is the dedicated "new_tab" nexus action (opens a tab in the
SAME window, not a new OS window).

If "action", classify further into one of two shapes:

1. NEXUS ACTIONS — desktop control (apps, files, folders, mouse, keyboard, windows, office docs) or
   browser control (navigate, click, fill forms, read pages). Use this whenever the user wants
   something done ON the laptop or IN a browser — including multi-step goals like "order X online"
   or "draft and send an email in Gmail" (break these into the FIRST concrete step; MCIS will ask
   again for the next step after seeing the result).

   IMPORTANT distinction: if the user wants to OPEN/LAUNCH their email (e.g. "email kholo", "open
   my email", "open gmail", "mera email account kholo"), classify as a NEXUS action — use
   "open_app" with parameters {app: "..."} for a desktop client (Outlook), or "navigate" with
   parameters {url: "https://mail.google.com"} for a browser. Only classify as the MCIS native
   "draftEmail" action (below) if the user explicitly wants an email DRAFTED/WRITTEN/COMPOSED
   (e.g. "email likh do", "draft an email to...", "compose an email"). The single word "email" by
   itself, with no verb, should default to opening it (NEXUS "navigate" to gmail.com), not drafting.

   DICTATION into Notepad/Word/any text editor (e.g. "notepad khol do", "ye likh: <text>", "ab
   yeh likh do <text>", "iske baad ye likh <text>"): the CONTENT to type is whatever the user
   literally said after the "likh"/"type"/"write" cue — copy it VERBATIM into payload.value. Do
   NOT paraphrase it, shorten it, or invent/expand it into a fuller paragraph. The user is
   dictating exact content one command at a time; your only job is to route it as a "type_text"
   action with target: { "role": "editor" } and value = exactly what they said to write. If a
   single message contains several dictated lines back to back (e.g. "ye likh hello phir yeh likh
   world phir ye likh done"), join them with "\n" between each line, in the same order, still
   verbatim — don't reword any of them.

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

   EXACT KEY NAMES Nexus's executor requires (get these wrong and the action
   fails to execute even though the intent was understood correctly —
   these are not optional/flexible, they're a fixed contract):
     open_app, close_app, restart_app, focus_app, minimize_app, maximize_app,
       switch_to_app  → parameters: { "app": "<app name>" }   (NOT "appName")
     focus_window, maximize_window, minimize_window, close_window,
       window_exists  → parameters: { "title": "<window title>" }   (NOT "window_title")
     hotkey           → parameters: { "keys": ["ctrl", "n"] }   (an array of key names)
     press_key        → parameters: { "key": "<single key>" }
     start_process, run_terminal → parameters: { "command": "<command>" }
     create_file, delete_file, read_file, verify_path, create_folder,
       delete_folder, list_folder, capture_screen, capture_active_window
                       → parameters: { "path": "<file or folder path>" }

2. MULTI-STEP GOALS — if the request needs SEVERAL different actions chained together to
   complete (e.g. "order X online", "book a cab", "fill and submit this form", "email X and
   also add a reminder") — classify as action "run_goal" with payload { "goal": "<the user's
   full original request, verbatim>" }. Do NOT try to break it into steps yourself; the task
   planner will do that.

3. MCIS NATIVE ACTIONS — AI/productivity tasks not related to controlling the laptop directly:
   ${MCIS_NATIVE_ACTIONS.join(', ')}

   Payload shape for these matches their existing specific fields (to, purpose, tone, context for
   draftEmail; text, dueAt for addReminder; etc. — use your best judgment based on the action name).

AMBIGUITY — when to use "clarify" instead of guessing:
Never invent a target/app/entity that isn't actually determinable. A request is genuinely
actionable but ambiguous when it uses a reference ("that", "it", "this", "another", "the same
one", "close it") and:
  (a) there is NO context to resolve it (no activeGoal, no results, no lastAction given), OR
  (b) the context gives MULTIPLE equally plausible candidates with nothing to disambiguate them
      (e.g. two different apps were both recently relevant and the message doesn't distinguish
      which one), OR
  (c) the reference is to a numbered/ordered result ("the first one", "the second one", "the
      cheapest") but CURRENT TASK CONTEXT's "results" list is empty or doesn't have that many
      entries.
In any of these cases, respond with "clarify" and a short, specific question -- e.g. "Which one
do you mean — Chrome or VS Code?" not a generic "Can you clarify?". Do NOT default to "chat" for
these (the request IS actionable, just underspecified) and do NOT guess an action/target you
aren't reasonably confident about.
When context DOES reliably resolve the reference (only one plausible candidate, or a results list
with enough entries for "the first one"/"the second one"), resolve it and classify as "action"
normally -- do not ask needlessly for something context already answers.

REPEATING THE LAST ACTION ("do that again", "do the same thing", "same as before"): only classify
this as a direct repeat of CURRENT TASK CONTEXT's lastAction if that action is one of:
${SAFE_TO_REPEAT_ACTIONS.join(', ')}
These are read-only/navigation actions where repeating changes nothing new, so it's safe to just
do it again. For any OTHER lastAction (typing, clicking a button, submitting a form, sending,
deleting, downloading, saving, paying, etc.) — these can have a real effect each time they run, so
do NOT silently repeat them. Instead respond with "clarify", asking the user to confirm they
really want to do that specific action again.

ANSWERING A PENDING CLARIFICATION: if CURRENT TASK CONTEXT includes a "pendingClarification"
(Nexus just asked a question), treat the user's message as very likely the answer to THAT
question, not a brand-new unrelated request — resolve it against pendingClarification.question
and pendingClarification.originalMessage together to determine the actual action.

Respond ONLY with JSON, no markdown, no explanation:
{ "type": "chat" | "action" | "clarify", "action": "<actionType or null>", "payload": {}, "question": "<only when type is clarify>" }`;

async function classifyIntent(userMessage, context = null) {
  let result;
  try {
    // context comes from taskContext.js (commandRoute.js passes it in) --
    // the active goal/constraints and last shown results from the user's
    // CURRENT task, if any. Without this, a follow-up like "make it under
    // 7000" or "open the first one" is genuinely ambiguous to classify in
    // isolation -- Gemini has no way to know what "it"/"the first one"
    // refers to. When context is null (fresh conversation, nothing
    // active), this adds nothing to the prompt.
    const contextBlock = context
      ? `\n\nCURRENT TASK CONTEXT (use this to resolve follow-ups, pronouns like "it"/"this"/
"that"/"the first one", and constraint changes like "make it cheaper" -- if the user's message
is a continuation/modification of this context rather than a brand-new request, classify it as
"run_goal" with a COMPLETE, standalone goal string that folds in the update, e.g. previous goal
"Find hotels in Goa under 5000" + user says "make it under 7000" -> goal: "Find hotels in Goa
under 7000". If the message is clearly unrelated to this context, ignore the context entirely):
${JSON.stringify(context)}`
      : '';
    const prompt = `${SYSTEM_PROMPT}${contextBlock}\n\nUser message: "${userMessage}"`;
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

  if (parsed.type === 'clarify' && !parsed.question) {
    // Defensive fallback -- the model said it needs to ask something but
    // didn't actually give a question. Don't silently guess an action;
    // ask a safe generic clarifying question instead of proceeding blind.
    parsed.question = 'Could you clarify what you mean?';
  }

  return parsed;
}

module.exports = { classifyIntent, NEXUS_ACTIONS, MCIS_NATIVE_ACTIONS, SAFE_TO_REPEAT_ACTIONS };