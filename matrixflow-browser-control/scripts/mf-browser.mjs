#!/usr/bin/env node
/**
 * MatrixFlow Browser Control CLI
 *
 * Drives the MatrixFlow antidetect browser windows through its local HTTP API
 * and Chrome DevTools Protocol (CDP). Requires Node.js >= 22 (built-in fetch
 * and WebSocket; no npm dependencies).
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
 *   node mf-browser.mjs eval <profileId|name> '<javascript>'
 *   node mf-browser.mjs screenshot <profileId|name> <output.png>
 *   node mf-browser.mjs click <profileId|name> <cssSelector>
 *   node mf-browser.mjs type <profileId|name> <cssSelector> <text>
 *   node mf-browser.mjs scroll <profileId|name> [deltaY]
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
  async function send(method, params = {}, sessionId) {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
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

async function getBrowserWs(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`CDP /json/version failed (${res.status})`);
  const json = await res.json();
  if (!json.webSocketDebuggerUrl) throw new Error("CDP webSocketDebuggerUrl missing");
  return json.webSocketDebuggerUrl;
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

async function connectPage(profileSpec) {
  const { profile: profileId, selector } = parseProfileSpec(profileSpec);
  const profileDir = findProfileDir(profileId);
  if (!profileDir) {
    throw new Error(`Profile ${profileId} has no DevToolsActivePort. Is it running?`);
  }
  const port = readPort(profileDir);
  const cdp = makeCdp(await getBrowserWs(port));
  const targets = await cdp.send("Target.getTargets");
  const pages = (targets.targetInfos || []).filter((t) => t.type === "page");
  const nonInternal = pages.filter(
    (t) => !t.url.startsWith("chrome-extension://") && !/browser-start/.test(t.url)
  );
  let page = null;
  if (selector) {
    const index = Number.parseInt(selector, 10);
    if (Number.isFinite(index)) {
      page = pages[index] || null;
    } else {
      page = pages.find((t) => t.url.includes(selector)) || null;
    }
  } else {
    page = nonInternal[0] || pages.find((t) => !t.url.startsWith("chrome-extension://")) || pages[0];
  }
  if (!page) {
    cdp.close();
    throw new Error(`No page target for profile ${profileId}`);
  }
  const attach = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  return { cdp, targetId: page.targetId, sessionId: attach.sessionId, page };
}

async function evalInPage(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error(`Page JS error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result?.value;
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

async function cmdStatus() {
  const info = { node: process.version, baseUrl: baseUrl(), token: resolveToken() ? "present" : "missing", userData: resolveUserDataRoot(), skillDir: SKILL_DIR };
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
  console.log(JSON.stringify({ ok: true, profileId: id, status: result.data?.status }, null, 2));
}

async function cmdClose(profile) {
  const id = await resolveProfileId(profile, { allowOffline: true });
  const result = await api(`/api/v1/profiles/${encodeURIComponent(id)}/close`, { method: "POST" });
  console.log(JSON.stringify({ ok: true, profileId: id, status: result.data?.status }, null, 2));
}

async function cmdPages(profile) {
  const { profile: profileId } = parseProfileSpec(profile);
  const id = await resolveProfileId(profileId);
  const profileDir = findProfileDir(id);
  if (!profileDir) throw new Error(`Profile ${id} has no DevToolsActivePort. Is it running?`);
  const port = readPort(profileDir);
  const cdp = makeCdp(await getBrowserWs(port));
  try {
    const targets = await cdp.send("Target.getTargets");
    const pages = (targets.targetInfos || []).filter((t) => t.type === "page");
    console.log(
      JSON.stringify(
        pages.map((p, i) => ({ index: i, url: p.url, title: p.title })),
        null,
        2
      )
    );
  } finally {
    cdp.close();
  }
}

async function cmdNavigate(profile, url) {
  if (!url) throw new Error("Usage: navigate <profile> <url>");
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    await cdp.send("Page.navigate", { url }, sessionId);
    await new Promise((r) => setTimeout(r, 2_000));
    const state = await evalInPage(cdp, sessionId, "JSON.stringify({url: location.href, title: document.title})");
    console.log(state);
  } finally {
    cdp.close();
  }
}

async function cmdTitle(profile) {
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    console.log(await evalInPage(cdp, sessionId, "JSON.stringify({url: location.href, title: document.title})"));
  } finally {
    cdp.close();
  }
}

async function cmdText(profile, maxChars) {
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    const limit = Number.parseInt(maxChars || "8000", 10);
    const text = await evalInPage(
      cdp,
      sessionId,
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
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    const value = await evalInPage(cdp, sessionId, expression);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdScreenshot(profile, output) {
  if (!output) throw new Error("Usage: screenshot <profile> <output.png>");
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    if (!shot.data) throw new Error("Screenshot returned no data");
    writeFileSync(output, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ ok: true, file: output, bytes: Buffer.from(shot.data, "base64").length }));
  } finally {
    cdp.close();
  }
}

async function cmdClick(profile, selector) {
  if (!selector) throw new Error("Usage: click <profile> <cssSelector>");
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    const rect = await evalInPage(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`
    );
    if (!rect) throw new Error(`Selector not found: ${selector}`);
    const { x, y } = JSON.parse(rect);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    console.log(JSON.stringify({ ok: true, selector, x, y }));
  } finally {
    cdp.close();
  }
}

async function cmdType(profile, selector, text) {
  if (!selector || text === undefined) throw new Error("Usage: type <profile> <cssSelector> <text>");
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    const focused = await evalInPage(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`
    );
    if (!focused) throw new Error(`Selector not found: ${selector}`);
    await cdp.send("Input.insertText", { text: String(text) }, sessionId);
    console.log(JSON.stringify({ ok: true, selector, inserted: String(text).length }));
  } finally {
    cdp.close();
  }
}

async function cmdScroll(profile, deltaY) {
  const { profile: profileId } = parseProfileSpec(profile);
  await resolveProfileId(profileId);
  const { cdp, sessionId } = await connectPage(profile);
  try {
    const amount = Number.parseInt(deltaY || "500", 10);
    await evalInPage(cdp, sessionId, `window.scrollBy(0, ${amount}); 'ok'`);
    console.log(JSON.stringify({ ok: true, deltaY: amount }));
  } finally {
    cdp.close();
  }
}

async function main() {
  if (typeof WebSocket === "undefined") {
    throw new Error("This skill requires Node.js >= 22 (built-in WebSocket).");
  }
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(
      [
        "MatrixFlow Browser Control",
        "Commands:",
        "  status                                  show app/token/userData status",
        "  list                                    list running environments (windows)",
        "  open <profileId|name> [url ...]          open an environment (optionally with URLs)",
        "  close <profileId|name>                   close an environment",
        "  pages <profileId|name>                   list page targets of a running environment",
        "  navigate <profileId|name> <url>          navigate active page",
        "  title <profileId|name>                   show active page url + title",
        "  text <profileId|name> [maxChars]         extract visible text (default 8000)",
        "  eval <profileId|name> '<js>'             run JS in the page, print result",
        "  screenshot <profileId|name> <file.png>   save a page screenshot",
        "  click <profileId|name> <cssSelector>     click element center",
        "  type <profileId|name> <cssSelector> <t>  focus element and insert text",
        "  scroll <profileId|name> [deltaY]         scroll page (default 500)",
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
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`[mf-browser] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
