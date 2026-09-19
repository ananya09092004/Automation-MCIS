/**
 * Shared 3-tier risk classification: GREEN / YELLOW / RED.
 *
 * This REPLACES two separate, duplicated binary gates that existed
 * before -- commandRoute.js's HIGH_RISK_ACTIONS list (single-command
 * path) and taskPlanner.js's SENSITIVE_KEYWORDS list (multi-step plan
 * path). Both are now driven by this one module, so there's a single
 * place that defines what's risky instead of two lists that could
 * silently drift apart.
 *
 * GREEN  -- safe to run fully autonomously, no extra gate, no added
 *           latency: reading, searching, browsing, comparing,
 *           calculating, summarizing, drafting, opening/focusing/
 *           closing apps, navigating, non-destructive UI interaction.
 * YELLOW -- has a real, meaningful effect but is not immediately
 *           irreversible/external: modifying/moving/renaming files,
 *           changing settings, filling forms, editing documents. Not
 *           blocked with a confirmation gate (that's RED's job), but
 *           callers should verify the result carefully rather than
 *           silently reporting success, and should not guess at an
 *           ambiguous target for one of these (see taskContext.js's
 *           clarify mechanism from PASS 1).
 * RED    -- irreversible and/or external-facing: payments, purchases,
 *           bookings, deletion, sending important messages, publishing,
 *           credentials. Requires explicit confirmation immediately
 *           before executing, exactly like the previous binary gates
 *           already did -- this tier's behavior is a rename/
 *           consolidation of existing logic, not new behavior.
 *
 * IMPORTANT -- this classifies ACTIONS (a bounded, internal, finite set
 * of capability names), not user phrases. It is not a command-phrase
 * dictionary: the user never has to say any of these words, they're
 * only ever compared against the already-classified action name and
 * its structured payload/keyword content coming out of the planner/
 * intent classifier.
 */

'use strict';

// RED: irreversible or external-facing actions. Immediate, explicit
// confirmation required before executing. This action-name set is the
// direct successor to commandRoute.js's old HIGH_RISK_ACTIONS.
const RED_ACTIONS = new Set([
  'delete_file', 'delete_folder', 'run_terminal', 'kill_process',
]);

// RED: keyword signal for actions whose payload/target text indicates a
// purchase, payment, booking, deletion, or credential-handling intent
// even when the action name itself is generic (e.g. a "click" on a
// "Book this hotel" button). Direct successor to taskPlanner.js's old
// SENSITIVE_KEYWORDS, unchanged content-wise (already hardened in an
// earlier pass to include book/purchase/delete/etc and to match
// snake_case action names).
const RED_KEYWORDS = [
  'password', 'card', 'cvv', 'otp', 'pay', 'checkout',
  'confirm order', 'place order', 'submit payment', 'login',
  'book', 'booking', 'reserve', 'reservation', 'purchase', 'buy',
  'delete', 'transfer money', 'send payment', 'wire transfer',
];

// YELLOW: has a real effect (modifies state) but isn't immediately
// irreversible or external. Was previously lumped into RED
// (HIGH_RISK_ACTIONS included move/rename/write_file and even
// close_app/close_window) -- per the 3-tier model these get verified
// more carefully rather than blocked with a confirmation prompt, which
// also removes unnecessary friction from actions like closing a window
// that were never actually high-risk.
const YELLOW_ACTIONS = new Set([
  'move_file', 'move_folder', 'rename_file', 'rename_folder',
  'write_file', 'fill_form', 'type_text', 'edit_file',
  'set_volume', 'install_software', 'organize_downloads',
]);

const YELLOW_KEYWORDS = ['setting', 'settings', 'important', 'overwrite'];

function _matchesKeyword(text, word) {
  const pattern = new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i');
  return pattern.test(text);
}

/**
 * Classify the risk tier of an action.
 *
 * @param {string} action - the internal action name (e.g. "delete_file",
 *   "open_app", "click"). Snake_case names are matched correctly (the
 *   underlying keyword check treats underscores as spaces).
 * @param {object} [payload] - the action's parameters/target/value, used
 *   for the keyword-based RED/YELLOW signal (e.g. a click whose target
 *   text says "Book this hotel"). Optional -- action-name-only
 *   classification still works without it.
 * @returns {'green'|'yellow'|'red'}
 */
function classifyRisk(action, payload) {
  const actionText = String(action || '').toLowerCase().replace(/_/g, ' ');
  const payloadText = payload ? JSON.stringify(payload).toLowerCase() : '';
  const combined = `${actionText} ${payloadText}`;

  if (RED_ACTIONS.has(action) || RED_KEYWORDS.some(w => _matchesKeyword(combined, w))) {
    return 'red';
  }
  if (YELLOW_ACTIONS.has(action) || YELLOW_KEYWORDS.some(w => _matchesKeyword(combined, w))) {
    return 'yellow';
  }
  return 'green';
}

module.exports = { classifyRisk, RED_ACTIONS, RED_KEYWORDS, YELLOW_ACTIONS, YELLOW_KEYWORDS };
