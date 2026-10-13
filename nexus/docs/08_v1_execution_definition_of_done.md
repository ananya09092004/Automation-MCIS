# Nexus V1 Execution Platform — Definition of Done

This is the acceptance checklist for the Desktop, Browser, Perception, and
Action/Verification platform only. Brain, integrations, backend, security
service, and frontend are intentionally excluded.

## Completion rule

A capability is complete only when its automated tests and its applicable
local live test pass. Code that merely compiles is not marked complete.

## Desktop

- [ ] App/window/process lifecycle
- [ ] Mouse, keyboard, clipboard, notifications, screenshots, terminal
- [ ] File/folder/File Explorer workflows with verification
- [ ] Windows UI Automation with OCR/image fallback
- [ ] Word, Excel, PowerPoint workflows

## Browser

- [ ] Chrome, Edge, Firefox, tabs, navigation, sessions
- [ ] Forms, approved login, uploads/downloads, tables/pagination/popups
- [ ] DOM inspection, wait/recovery, page-change verification

## Perception

- [ ] Screen capture, OCR, UIA/DOM, icon templates, error/loading detection
- [ ] Confidence-gated target selection and evidence

## Action and verification

- [ ] Shared action/result contracts, workflow, safe retry
- [ ] Approval boundary, screenshots/state, conservative rollback

## Real acceptance workflows

- [ ] File Explorer, Notepad, Word, Excel, browser research/form/download/login
- [ ] Failure recovery and approval blocking
- [ ] Consolidated test suite passes with no real payments/emails/deletes
