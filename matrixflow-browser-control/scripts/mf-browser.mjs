#!/usr/bin/env node
/**
 * MatrixFlow Browser Control CLI (speed-optimized)
 *
 * Drives the MatrixFlow antidetect browser windows through its local HTTP API
 * and Chrome DevTools Protocol (CDP). Requires Node.js >= 22 (built-in fetch
 * and WebSocket; no npm dependencies).
 *
 * Speed design:
 * - Connects DIRECTLY to the page-level DevTools websocket (from /json/list),
 *   skipping browser-level attach round-trips.
 * - `navigate` polls `document.readyState` instead of sleeping a fixed time.
 * - `open` waits until the window is CDP-ready before returning.
 * - `run` executes a batch of steps over ONE connection (no per-step process
 *   startup / reconnect), which is the fastest way to do multi-step tasks.
 *
 * Usage:
 *   node mf-browser.mjs status
 *   node mf-browser.mjs list
 *   node mf-browser.mjs open <profileId|name> [url ...]
 *   node mf-browser.mjs close <profileId|name>
 *   node mf-browser.mjs pages <profileId|name>
 *   node mf-browser.mjs navigate <profileId|name> <url>
 *   node mf-browser.mjs title <profileId|name>
 *   node mf-browser.mjs text <profileId|name> [maxChars]
 *   node mf-browser.mjs eval <profileId|name> '<javascript>'   (or '-' + stdin)
 *   node mf-browser.mjs screenshot <profileId|name> <file.png>
 *   node mf-browser.mjs click <profileId|name> <cssSelector>
 *   node mf-browser.mjs type <profileId|name> <cssSelector> <text>
 *   node mf-browser.mjs scroll <profileId|name> [deltaY]
 *   node mf-browser.mjs run <profileId|name> '<steps-json>'     (or '-' + stdin)
 *
 * run steps (executed in one connection, in order):
 *   {"op":"navigate","url":"...","waitReady":true}
 *   {"op":"wait","ms":1000} | {"op":"waitReady","timeout":15000}
 *   {"op":"eval","js":"..."}
 *   {"op":"click","selector":"..."} | {"op":"type","selector":"...","text":"..."}
 *   {"op":"scroll","deltaY":500} | {"op":"text","max":2000} | {"op":"title":true}
 *   {"op":"screenshot","path":"..."}
 *
 * Environment:
 *   MF_LOCAL_API         local API base (default http://127.0.0.1:19527)
 *   MF_LOCAL_API_TOKEN   token override (default read from userData)
 *   MF_USER_DATA         userData root override
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..");
const DEFAULT_PORT = 19527;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveUserDataRoot() {
  if (process.env.MF_USER_DATA) return process.env.MF_USER_DATA;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "@matrixflow", "desktop");
}

function baseUrl() {
  return (process.env.MF_LOCAL_API || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
}

function resolveToken() {
  if (process.env.MF_LOCAL_API_TOKEN) return process.env.MF_LOCAL_API_TOKEN.trim();
  try {
    const p = join(resolveUserDataRoot(), "local-api-token.txt");
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8").trim();
      if (t) return t;
    }
  } catch {}
  return "";
}

async function api(pathname, { method = "GET", body } = {}) {
  const token = resolveToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-MatrixFlow-Token"] = token;
  const res = await fetch(baseUrl() + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    throw new Error(`API ${method} ${pathname} -> ${res.status}: ${json?.error?.message || res.statusText}`);
  }
  return json;
}

function findProfileDir(profileId) {
  const profilesRoot = join(resolveUserDataRoot(), "Profiles");
  if (!existsSync(profilesRoot)) return null;
  const stack = [profilesRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === profileId && existsSync(join(full, "DevToolsActivePort"))) {
          return full;
        }
        stack.push(full);
      }
    }
  }
  return null;
}

function readPort(profileDir) {
  const first = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0];
  const port = Number.parseInt(first, 10);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid DevToolsActivePort: ${first}`);
  return port;
}

async function resolveProfileId(profile, { allowOffline = false } = {}) {
  const running = await api("/api/v1/profiles/running");
  const runningList = running.data || [];
  const byId = runningList.find((p) => p.profileId === profile);
  if (byId) return byId.profileId;
  let fullList = [];
  try {
    const full = await api("/api/v1/profiles");
    fullList = full.data || [];
  } catch {}
  const fullById = fullList.find((p) => p.id === profile);
  if (fullById) return fullById.id;
  const fullByName = fullList.find((p) => p.name === profile);
  if (fullByName) return fullByName.id;
  if (allowOffline) {
    throw new Error(`Profile not found: ${profile}`);
  }
  throw new Error(`Profile not found (running): ${profile}. Open it first or use an exact id.`);
}

function parseProfileSpec(spec) {
  const at = String(spec || "").lastIndexOf("@");
  if (at > 0) {
    return { profile: spec.slice(0, at), selector: spec.slice(at + 1) };
  }
  return { profile: spec, selector: "" };
}

function makeCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`CDP connect failed: ${wsUrl}`));
  });
  async function send(method, params = {}) {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    ws,
    send,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function findPageTarget(port, selector) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`CDP /json/list failed (${res.status})`);
  const targets = await res.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page");
  const nonInternal = pages.filter((t) => !/browser-start/.test(t.url || ""));
  let page = null;
  if (selector) {
    const index = Number.parseInt(selector, 10);
    if (Number.isFinite(index)) {
      page = pages[index] || null;
    } else {
      page =
        pages.find((t) => (t.url || "").includes(selector)) ||
        pages.find((t) => (t.title || "").includes(selector)) ||
        null;
    }
  }
  if (!page) {
    page = nonInternal[0] || pages[0] || null;
  }
  if (!page) throw new Error(`No page target on port ${port}`);
  return page;
}

async function connectPage(profileSpec) {
  const { profile, selector } = parseProfileSpec(profileSpec);
  let profileDir = findProfileDir(profile);
  if (!profileDir) {
    const id = await resolveProfileId(profile);
    profileDir = findProfileDir(id);
  }
  if (!profileDir) {
    throw new Error(`Profile ${profile} has no DevToolsActivePort. Is it running?`);
  }
  const port = readPort(profileDir);
  const page = await findPageTarget(port, selector);
  if (!page.webSocketDebuggerUrl) {
    throw new Error(`Page target has no webSocketDebuggerUrl: ${page.url}`);
  }
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  // 把目标标签页激活为窗口的活动标签页，确保操作落在用户当前看到的页面上
  await cdp.send("Page.bringToFront").catch(() => void 0);
  return { cdp, page, port };
}

async function evalInPage(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`Page JS error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

async function waitReady(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evalInPage(cdp, "document.readyState");
      if (state === "complete") return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

/* ---------------- single commands ---------------- */

async function cmdStatus() {
  const info = {
    node: process.version,
    baseUrl: baseUrl(),
    token: resolveToken() ? "present" : "missing",
    userData: resolveUserDataRoot(),
    skillDir: SKILL_DIR,
  };
  try {
    const res = await fetch(`${baseUrl()}/api-docs-guide`, { signal: AbortSignal.timeout(3_000) });
    info.appRunning = res.ok;
  } catch {
    info.appRunning = false;
  }
  console.log(JSON.stringify(info, null, 2));
}

async function cmdList() {
  const running = await api("/api/v1/profiles/running");
  console.log(JSON.stringify(running.data || [], null, 2));
}

async function cmdOpen(args) {
  const profile = args[0];
  if (!profile) throw new Error("Usage: open <profileId|name> [url ...]");
  const id = await resolveProfileId(profile, { allowOffline: true });
  const postLaunchUrls = args.slice(1).filter(Boolean);
  const result = await api(`/api/v1/profiles/${encodeURIComponent(id)}/open`, {
    method: "POST",
    body: postLaunchUrls.length ? { postLaunchUrls } : {},
  });
  // 等待窗口 CDP 就绪（最多 25 秒），避免调用方再盲目 sleep
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const dir = findProfileDir(id);
    if (dir) {
      try {
        const port = readPort(dir);
        await findPageTarget(port, "");
        break;
      } catch {}
    }
    await sleep(300);
  }
  console.log(JSON.stringify({ ok: true, profileId: id, status: result.data?.status }, null, 2));
}

async function cmdClose(profile) {
  const id = await resolveProfileId(profile, { allowOffline: true });
  const result = await api(`/api/v1/profiles/${encodeURIComponent(id)}/close`, { method: "POST" });
  console.log(JSON.stringify({ ok: true, profileId: id, status: result.data?.status }, null, 2));
}

async function cmdPages(profile) {
  const { profile: profileId } = parseProfileSpec(profile);
  let profileDir = findProfileDir(profileId);
  if (!profileDir) {
    const id = await resolveProfileId(profileId);
    profileDir = findProfileDir(id);
  }
  if (!profileDir) throw new Error(`Profile ${profileId} has no DevToolsActivePort. Is it running?`);
  const port = readPort(profileDir);
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  const targets = await res.json();
  console.log(
    JSON.stringify(
      (Array.isArray(targets) ? targets : [])
        .filter((t) => t.type === "page")
        .map((p, i) => ({ index: i, url: p.url, title: p.title })),
      null,
      2
    )
  );
}

async function cmdNavigate(profile, url) {
  if (!url) throw new Error("Usage: navigate <profile> <url>");
  const { cdp } = await connectPage(profile);
  try {
    await cdp.send("Page.navigate", { url });
    await waitReady(cdp, 20_000);
    const state = await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})");
    console.log(state);
  } finally {
    cdp.close();
  }
}

async function cmdTitle(profile) {
  const { cdp } = await connectPage(profile);
  try {
    console.log(await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})"));
  } finally {
    cdp.close();
  }
}

async function cmdText(profile, maxChars) {
  const { cdp } = await connectPage(profile);
  try {
    const limit = Number.parseInt(maxChars || "8000", 10);
    const text = await evalInPage(
      cdp,
      `(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return JSON.stringify({text: t.slice(0, ${limit}), length: t.length}); })()`
    );
    console.log(text);
  } finally {
    cdp.close();
  }
}

async function cmdEval(profile, expression) {
  if (!expression || expression === "-") {
    expression = await readStdin();
  }
  if (!expression) throw new Error("Usage: eval <profile> '<javascript>'  (or pipe JS via stdin with '-')");
  const { cdp } = await connectPage(profile);
  try {
    const value = await evalInPage(cdp, expression);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdScreenshot(profile, output) {
  if (!output) throw new Error("Usage: screenshot <profile> <output.png>");
  const { cdp } = await connectPage(profile);
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!shot.data) throw new Error("Screenshot returned no data");
    const buf = Buffer.from(shot.data, "base64");
    writeFileSync(output, buf);
    console.log(JSON.stringify({ ok: true, file: output, bytes: buf.length }));
  } finally {
    cdp.close();
  }
}

async function cmdClick(profile, selector) {
  if (!selector || selector === "-") {
    selector = await readStdin();
  }
  if (!selector) throw new Error("Usage: click <profile> <cssSelector>  (or pipe selector via stdin with '-')");
  const { cdp } = await connectPage(profile);
  try {
    const rect = await evalInPage(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`
    );
    if (!rect) throw new Error(`Selector not found: ${selector}`);
    const { x, y } = JSON.parse(rect);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    console.log(JSON.stringify({ ok: true, selector, x, y }));
  } finally {
    cdp.close();
  }
}

async function cmdType(profile, selector, text) {
  if (!selector || selector === "-") {
    selector = await readStdin();
  }
  if (!selector) throw new Error("Usage: type <profile> <cssSelector> <text>");
  const { cdp } = await connectPage(profile);
  try {
    const focused = await evalInPage(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`
    );
    if (!focused) throw new Error(`Selector not found: ${selector}`);
    await cdp.send("Input.insertText", { text: String(text) });
    console.log(JSON.stringify({ ok: true, selector, inserted: String(text).length }));
  } finally {
    cdp.close();
  }
}

async function cmdScroll(profile, deltaY) {
  const { cdp } = await connectPage(profile);
  try {
    const amount = Number.parseInt(deltaY || "500", 10);
    await evalInPage(cdp, `window.scrollBy(0, ${amount}); 'ok'`);
    console.log(JSON.stringify({ ok: true, deltaY: amount }));
  } finally {
    cdp.close();
  }
}

/* ---------------- run: batch steps over one connection ---------------- */

async function cmdRun(profile, stepsJson) {
  if (!stepsJson || stepsJson === "-") {
    stepsJson = await readStdin();
  }
  const steps = JSON.parse(stepsJson);
  if (!Array.isArray(steps)) throw new Error("run steps must be a JSON array");
  const { cdp } = await connectPage(profile);
  const results = [];
  try {
    for (const step of steps) {
      const started = Date.now();
      let value;
      switch (step.op) {
        case "navigate": {
          await cdp.send("Page.navigate", { url: step.url });
          if (step.waitReady !== false) await waitReady(cdp, step.timeout || 20_000);
          value = await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})");
          break;
        }
        case "wait":
          await sleep(Number(step.ms) || 500);
          value = "ok";
          break;
        case "waitRandom": {
          const min = Number(step.min) || 300;
          const max = Number(step.max) || 1200;
          const ms = Math.floor(min + Math.random() * Math.max(0, max - min));
          await sleep(ms);
          value = ms;
          break;
        }
        case "waitReady":
          value = await waitReady(cdp, step.timeout || 20_000);
          break;
        case "eval":
          value = await evalInPage(cdp, step.js);
          break;
        case "click": {
          const rect = await evalInPage(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`
          );
          if (!rect) throw new Error(`Selector not found: ${step.selector}`);
          const { x, y } = JSON.parse(rect);
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          value = { x, y };
          break;
        }
        case "type": {
          const focused = await evalInPage(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (!el) return false; el.focus(); return true; })()`
          );
          if (!focused) throw new Error(`Selector not found: ${step.selector}`);
          await cdp.send("Input.insertText", { text: String(step.text) });
          value = "typed";
          break;
        }
        case "scroll":
          await evalInPage(cdp, `window.scrollBy(0, ${Number(step.deltaY) || 500}); 'ok'`);
          value = "ok";
          break;
        case "text": {
          const limit = Number(step.max) || 8000;
          value = await evalInPage(
            cdp,
            `(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return JSON.stringify({text: t.slice(0, ${limit}), length: t.length}); })()`
          );
          break;
        }
        case "title":
          value = await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})");
          break;
        case "screenshot": {
          const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          const buf = Buffer.from(shot.data || "", "base64");
          writeFileSync(step.path, buf);
          value = { file: step.path, bytes: buf.length };
          break;
        }
        default:
          throw new Error(`Unknown run op: ${step.op}`);
      }
      results.push({ op: step.op, ms: Date.now() - started, value });
    }
  } finally {
    cdp.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

/* ---------------- main ---------------- */

async function main() {
  if (typeof WebSocket === "undefined") {
    throw new Error("This skill requires Node.js >= 22 (built-in WebSocket).");
  }
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(
      [
        "MatrixFlow Browser Control (speed-optimized)",
        "Commands:",
        "  status                                    show app/token/userData status",
        "  list                                      list running environments (windows)",
        "  open <profileId|name> [url ...]            open an environment (waits until CDP-ready)",
        "  close <profileId|name>                     close an environment",
        "  pages <profileId|name>                     list page tabs of a running environment",
        "  navigate <profileId|name> <url>            navigate active page (waits for load)",
        "  title <profileId|name>                     show active page url + title",
        "  text <profileId|name> [maxChars]           extract visible text (default 8000)",
        "  eval <profileId|name> '<js>'               run JS in the page (or '-' + stdin)",
        "  screenshot <profileId|name> <file.png>     save a page screenshot",
        "  click <profileId|name> <cssSelector>       click element center (auto scrolls into view)",
        "  type <profileId|name> <cssSelector> <t>    focus element and insert text",
        "  scroll <profileId|name> [deltaY]           scroll page (default 500)",
        "  run <profileId|name> '<steps-json>'        batch steps in ONE connection (or '-' + stdin)",
        "",
        "Pin a tab: use profileId@<url-substring> (preferred) or profileId@<index>.",
      ].join("\n")
    );
    return;
  }
  switch (command) {
    case "status": return await cmdStatus();
    case "list": return await cmdList();
    case "open": return await cmdOpen(args);
    case "close": return await cmdClose(args[0]);
    case "pages": return await cmdPages(args[0]);
    case "navigate": return await cmdNavigate(args[0], args[1]);
    case "title": return await cmdTitle(args[0]);
    case "text": return await cmdText(args[0], args[1]);
    case "eval": return await cmdEval(args[0], args[1]);
    case "screenshot": return await cmdScreenshot(args[0], args[1]);
    case "click": return await cmdClick(args[0], args[1]);
    case "type": return await cmdType(args[0], args[1], args[2]);
    case "scroll": return await cmdScroll(args[0], args[1]);
    case "run": return await cmdRun(args[0], args[1]);
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`[mf-browser] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
