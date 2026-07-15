# Changelog

All notable changes to AskFirst are documented here.

## [0.0.2] — 2026-07-15

- Right-click menu on selected text, `Cmd/Ctrl+Alt+R` keybinding, and a status bar button — three new ways to start refining
- Back button (←) in the question flow to change earlier answers
- Escape now asks before discarding your answers instead of silently aborting
- "Copy Prompt" / "Refine Again" actions when the result is ready, plus an `askfirst.autoCopy` setting
- Getting-started walkthrough (Ollama install → pull model → first refine)

## [0.0.1] — 2026-07-15

Initial release.

- **Refine Prompt** command: analyzes a rough prompt, asks 3–4 clarifying multiple-choice questions, and rewrites it into a structured, self-contained prompt (Task / Audience / Requirements / Constraints / Success Criteria)
- Runs locally on Ollama by default — free, private, no API key
- Optional Anthropic and OpenAI support with your own API key, stored in the OS keychain
- Answer options include "type my own answer" and "skip"; result opens in an editor tab beside your work
