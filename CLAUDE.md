# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first: it is the source of truth for this project's purpose, non-negotiables, commands and structure.

Claude-specific notes:

- `ideas.md` is the user's sketchpad. Do not take TODOs from it unless asked; it does hold standing preferences (e.g. "simple shapes first; give me a ChatGPT prompt when real graphics are needed").
- On this Windows machine Git Bash may not have Node on `PATH`. Use `export PATH="/c/Program Files/nodejs:$PATH";` before `npm`/`npx`, or use PowerShell.
- Long heredocs through the Bash tool can fail to parse; prefer the Write/Edit tools for source files.
- Before finishing a task: `npm run typecheck && npm run lint && npm test`, and for UI changes run the dev server and check the page in a browser.
- Keep protocol behaviour in `src/sim` and keep it testable; the UI only animates `SimResult`.
