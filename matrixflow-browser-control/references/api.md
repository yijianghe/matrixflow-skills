# MatrixFlow local API reference

## Base

- Base URL: `http://127.0.0.1:19527` (env override: `MF_LOCAL_API`)
- Auth header: `X-MatrixFlow-Token: <token>` (or `Authorization: Bearer <token>`)
- Token file: `<userData>/local-api-token.txt`; env override: `MF_LOCAL_API_TOKEN`
- userData: `%APPDATA%\@matrixflow\desktop` (Windows), `~/Library/Application Support/@matrixflow/desktop` (macOS), `~/.config/@matrixflow/desktop` (Linux); env override: `MF_USER_DATA`
- Response shape: `{ "success": true, "data": ... }` or `{ "success": false, "error": { "message": "..." } }`

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/profiles/running` | List running environments (windows) |
| GET | `/api/v1/profiles` | List all environments (falls back to running-only offline) |
| POST | `/api/v1/profiles/:id/open` | Open an environment window. Body (optional): `postLaunchUrls: string[]`, `startupUrl`, `colorMode`, `loadAutomaExtension`, `automaWorkflowId`, `headless`, `windowSize` |
| POST | `/api/v1/profiles/:id/close` | Close an environment window |
| GET | `/api/v1/matrixflow/local-api/info` | Return `baseUrl`, `token`, `header`, `swaggerUrl`, `docsUrl` |
| GET | `/api/v1/matrixflow/workflows` | List workflows |
| GET | `/api/v1/matrixflow/rpa/target-tabs` | List RPA target tabs |

## CDP (per-window page control)

Each running environment's Chromium exposes DevTools at:

```
<userData>/Profiles/<userId>/<profileId>/DevToolsActivePort
```

Read the first line for the debug port, then:

- Browser endpoint: `http://127.0.0.1:<port>/json/version` → `webSocketDebuggerUrl`
- Page targets: `Target.getTargets` → filter `type === "page"` and skip `chrome-extension://`
- Attach: `Target.attachToTarget` (flatten) → sessionId
- Operate: `Page.navigate`, `Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.insertText`, `Page.captureScreenshot`

The skill's `scripts/mf-browser.mjs` wraps all of this; prefer it over raw calls.

## Troubleshooting

- **API unreachable / 401**: MatrixFlow app is not running, or the token file is missing. Start the app, then check the token in app Settings → API 文档.
- **DevToolsActivePort not found**: the environment is not running. Open it first (`open`), wait a few seconds for the browser to start.
- **Multiple windows per profile**: CDP ops target the first non-extension page of that profile's window.
