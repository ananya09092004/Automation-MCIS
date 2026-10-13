# Supported Actions

This document describes the actions exposed by `ExecutionGateway`. An action
must be present in `common/capabilities.py`; otherwise the gateway returns a
safe structured failure.

## Common fields

| Field | Meaning |
|---|---|
| `platform` | `desktop` or `browser` |
| `action` | One action name below |
| `parameters` | Non-sensitive named inputs such as `path`, `url`, or `timeout` |
| `target` | UI target: desktop window handle/title/control metadata, or browser selector/role/label/text |
| `value` | Primary non-sensitive value, e.g. text or rows |
| `approval_token` | Required for sensitive/destructive actions |

Set `parameters.capture_evidence` to `true` to attach best-effort before/after
screenshots. Screenshot failure is reported as evidence and never changes the
main action outcome.

## Desktop actions

| Group | Actions |
|---|---|
| Apps | `open_app`, `close_app`, `restart_app`, `focus_app`, `minimize_app`, `maximize_app`, `switch_to_app`, `get_running_apps` |
| Files | `create_file`, `read_file`, `write_file`, `rename_file`, `copy_file`, `move_file`, `delete_file`, `search_file`, `verify_path` |
| Folders | `create_folder`, `rename_folder`, `copy_folder`, `move_folder`, `delete_folder`, `search_folder`, `list_folder` |
| File Explorer | `open_path`, `reveal_file`, `open_file`, `list_items`, `search_items` |
| Mouse | `move_mouse`, `click`, `double_click`, `right_click`, `drag_mouse`, `scroll_up`, `scroll_down`, `mouse_position` |
| Keyboard/clipboard | `type_text`, `press_key`, `hotkey`, `select_all`, `copy_selection`, `paste_selection`, `cut_selection`, `copy_text`, `paste_text`, `get_clipboard`, `clear_clipboard`, `cut_clipboard` |
| Window/process | `focus_window`, `minimize_window`, `maximize_window`, `close_window`, `window_exists`, `active_window`, `start_process`, `kill_process`, `restart_process`, `list_processes` |
| UI Automation | `inspect_window`, `click_target`, `fill_target`, `read_target`, `target_exists`, `wait_for_target`, `inspect_screen_state` |
| System evidence | `capture_screen`, `capture_active_window`, `notify`, `read_notifications`, `clear_notifications`, `run_terminal` |
| Office | `create_word_document`, `read_word_document`, `create_excel_workbook`, `read_excel_rows`, `create_powerpoint_presentation`, `inspect_powerpoint_presentation`, `open_office_document` |

Desktop target lookup prefers `window_handle` when known, otherwise use
`window_title`/`app` plus `name`, `automation_id`, or `control_type`. Lookup
uses Windows UI Automation first, then image/OCR only with a confidence gate.

`read_notifications` reads only the Nexus notification history for the current
process; it is not a claim to read all private Windows notifications.

## Browser actions

| Group | Actions |
|---|---|
| Navigation/tabs | `navigate`, `back`, `forward`, `refresh`, `new_tab`, `switch_tab`, `close_tab`, `wait_for` |
| Read/observe | `inspect_page`, `inspect_page_state`, `read_text`, `read_tables` |
| Interaction | `click`, `hover`, `fill`, `type`, `press`, `select`, `check`, `uncheck` |
| Structured page navigation | `next_page`, `previous_page`, `infinite_scroll`, `dismiss_safe_popup` |
| Files/session | `upload`, `download`, `save_session`, `load_session` |
| Sensitive/form | `fill_form`, `login` |

Browser targets support `selector`, `role` + `name`, `label`, `placeholder`, or
visible `text`. `login` requires approval. `fill_form` never submits. Upload,
download, checked state, expected text/URL, and optional page change are
verified where applicable. `dismiss_safe_popup` dismisses only controls named
Close, Cancel, or Dismiss.

## High-risk actions

Approval is enforced before: `delete_file`, `delete_folder`, `move_file`,
`move_folder`, `rename_file`, `rename_folder`, `write_file`, `run_terminal`,
`kill_process`, `close_app`, `close_window`, `login`, `send`, `submit`, `book`,
`pay`, and `purchase`.

`send`, `submit`, `book`, `pay`, and `purchase` are deliberately not implemented
as automatic platform actions. They must remain an explicit user-approved
integration-layer decision.
