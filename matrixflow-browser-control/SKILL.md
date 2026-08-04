---
name: matrixflow-browser-control
description: 'Control the MatrixFlow antidetect browser (windows = environments) from the agent: open/close browser windows, navigate web pages, click, type, scroll, extract text, run JS, take screenshots. Use when the user asks to drive the MatrixFlow browser (or a browser window/environment) to browse a website, search, fill forms, scrape pages, check pages, or perform web tasks through the installed MatrixFlow browser.'
---

# MatrixFlow Browser Control

Drive MatrixFlow's antidetect browser windows ("environments") via the local HTTP API and Chrome DevTools Protocol (CDP). This is the agent-side equivalent of an AI takeover of a browser window: open a real browser window, navigate it, interact with pages, read content, and capture screenshots.

## Prerequisites

- MatrixFlow desktop app is running (start it if `status` says the API is unreachable).
- Node.js >= 22 on PATH (the script uses built-in `fetch` + `WebSocket` only).
- Script: `scripts/mf-browser.mjs` (run with `node`).

## Quick start

```bash
node scripts/mf-browser.mjs status          # confirm app running + token present
node scripts/mf-browser.mjs list            # list running environments (windows)
node scripts/mf-browser.mjs open <id|name>  # open an environment window
node scripts/mf-browser.mjs navigate <id|name> https://example.com
node scripts/mf-browser.mjs text <id|name>
```

Always run `status` first: it prints the API base URL, whether the app is running, and whether the token was found. If the app is not running, start it, then re-check.

## Workflow

1. **Ensure the app is up**: `node scripts/mf-browser.mjs status`. If `appRunning` is false, start MatrixFlow and wait for its API (a few seconds), then re-run.
2. **Pick a window**: `node scripts/mf-browser.mjs list` returns running environments. Use an exact `profileId` (or name) for all subsequent commands.
3. **Open one if needed**: `open <id|name> [url ...]` starts the environment; wait ~5-10 seconds for Chromium to boot before operating.
4. **Interact**: navigate → wait for load → read `text`/`title` → `click`/`type`/`scroll` → verify with `text` or `screenshot`.
5. **Clean up**: `close <id|name>` when done (optional; leave windows open if the user wants them).

## Commands

| Command | Purpose |
| --- | --- |
| `status` | Show app status, API base, token presence, userData path |
| `list` | List running environments (profileId, status, url) |
| `open <id\|name> [url ...]` | Open an environment, optionally with startup URLs |
| `close <id\|name>` | Close an environment window |
| `pages <id\|name>` | List the page tabs of a running environment (with index) |
| `navigate <id\|name> <url>` | Navigate the active page to a URL |
| `title <id\|name>` | Print active page `url` + `title` |
| `text <id\|name> [maxChars]` | Extract visible page text (default 8000 chars) |
| `eval <id\|name> '<js>'` | Run JS in the page and print the result (or pass `-` and pipe JS via stdin to avoid shell quoting issues) |
| `screenshot <id\|name> <file.png>` | Save a screenshot of the page |
| `click <id\|name> <cssSelector>` | Click the center of the first matching element |
| `type <id\|name> <cssSelector> <text>` | Focus the element and insert text |
| `scroll <id\|name> [deltaY]` | Scroll the page (default 500) |

## Rules and notes

- **Identifiers**: use the exact `profileId` from `list` (or a profile name). If a profile is not running, `open` it first; CDP commands need a running window.
- **Window model**: each environment is one browser window that may contain several tabs. By default commands operate the first non-internal page tab. If a window has multiple tabs, run `pages` first, then pin a tab with `profileId@<index>` (e.g. `cmse…@1`) or `profileId@<url-substring>` (e.g. `cmse…@baidu.com`) for all page commands. If the page is a MatrixFlow internal start page (`browser.lingjingxia.com/browser-start`), navigate to the real target URL first.
- **Waiting**: after `navigate`, wait 2-5 seconds (or poll `title`/`text`) before acting; pages load asynchronously.
- **selectors**: standard CSS selectors. `click` uses the element's bounding-box center via CDP input events (real page interaction). `type` focuses the element then inserts text.
- **eval results**: primitive values print as-is; objects print as JSON.
- **Screenshots**: saved as PNG at the given path (use an absolute path). Inspect the image afterward to verify page state.
- **Multi-step tasks**: prefer short round-trips: navigate → read text → decide → click/type → verify. Re-read `text` after actions to confirm effects.
- **Failure handling**: "Profile has no DevToolsActivePort" means the window is not running yet — wait and retry, or `open` it. "API 401" means the token file is missing — get the token from app Settings → API 文档.

## Reference

For the local API details (auth, endpoints, CDP layout, troubleshooting) see `references/api.md`.
