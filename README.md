# MatrixFlow Skills

Codex skills for working with the MatrixFlow antidetect browser.

## matrixflow-browser-control

Let Codex (or any agent with a Codex-like skill runner) take over a MatrixFlow
browser window to browse the web: open/close windows, navigate, click, type,
scroll, extract text, run JS, and take screenshots.

### Install

```bash
# Windows: %USERPROFILE%\.codex\skills
# macOS/Linux: ~/.codex/skills
git clone <this repo> "$HOME/.codex/skills/matrixflow-skills"
# or just copy the skill folder:
cp -r matrixflow-browser-control "$HOME/.codex/skills/"
```

### Requirements

- MatrixFlow desktop app installed and running (local API on `127.0.0.1:19527`).
- Node.js >= 22 for `scripts/mf-browser.mjs` (uses built-in `fetch` + `WebSocket`).

### Quick start

```bash
node matrixflow-browser-control/scripts/mf-browser.mjs status
node matrixflow-browser-control/scripts/mf-browser.mjs list
node matrixflow-browser-control/scripts/mf-browser.mjs open <profileId|name> https://example.com
node matrixflow-browser-control/scripts/mf-browser.mjs text <profileId>
node matrixflow-browser-control/scripts/mf-browser.mjs screenshot <profileId> page.png
```

See `matrixflow-browser-control/SKILL.md` for the full command reference.
