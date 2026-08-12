#!/usr/bin/env node
/**
 * Facebook 登录状态检测：导航到 facebook.com，判断当前窗口是否已登录。
 * 用法: node fb-login-status.mjs <profileId> [url]
 * 输出: {"loggedIn":bool,"state":"feed|login|checkpoint|locked|other","url":"...","title":"..."}
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const profileSpec = process.argv[2];
const targetUrl = process.argv[3] || "https://www.facebook.com/";
if (!profileSpec) {
  console.error("用法: fb-login-status.mjs <profileId> [url]");
  process.exit(1);
}

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

function findProfileDir(profileId) {
  const root = resolveUserDataRoot();
  const profilesRoot = join(root, "Profiles");
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

function parseProfileSpec(spec) {
  const at = String(spec || "").lastIndexOf("@");
  if (at > 0) return { profile: spec.slice(0, at), selector: spec.slice(at + 1) };
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
  return { ws, send, close: () => { try { ws.close(); } catch {} } };
}

async function findPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CDP /json/list failed (${res.status})`);
  const targets = await res.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page");
  const nonInternal = pages.filter((t) => !/browser-start/.test(t.url || ""));
  const page = nonInternal[0] || pages[0] || null;
  if (!page) throw new Error(`No page target on port ${port}`);
  return page;
}

async function connectPage(profileSpec2) {
  const { profile, selector } = parseProfileSpec(profileSpec2);
  let profileDir = findProfileDir(profile);
  if (!profileDir) throw new Error(`Profile ${profile} has no DevToolsActivePort. Is it running?`);
  const port = readPort(profileDir);
  const page = selector
    ? (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .filter((t) => t.type === "page")
        .find((t) => (t.url || "").includes(selector)) || (await findPageTarget(port))
    : await findPageTarget(port);
  if (!page.webSocketDebuggerUrl) throw new Error(`Page target has no webSocketDebuggerUrl: ${page.url}`);
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => undefined);
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await evalInPage(cdp, "document.readyState");
      if (state === "complete") return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const { cdp } = await connectPage(profileSpec);
try {
  await cdp.send("Page.navigate", { url: targetUrl });
  await waitReady(cdp, 20_000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3500));
  const state = await evalInPage(
    cdp,
    `(() => {
      const url = location.href || '';
      const lower = url.toLowerCase();
      const hasLoginForm =
        !!document.querySelector('form[data-testid="royal_login_form"]') ||
        !!document.querySelector('#loginform') ||
        !!document.querySelector('input[name="email"]') ||
        !!document.querySelector('input[name="pass"]');
      const feed = !!document.querySelector('div[role="feed"]');
      const accountSwitcher = !!document.querySelector('[data-testid="current_account_switcher"]');
      const title = document.title || '';
      let state = 'other';
      if (lower.includes('/checkpoint') || title.includes('确认你的身份') || title.includes('Checkpoint') || title.includes('Security Check')) {
        state = 'checkpoint';
      } else if (title.includes('你的账号已被锁定') || title.includes('暂时无法使用') || title.includes('Account Temporarily Unavailable') || title.includes('locked')) {
        state = 'locked';
      } else if (hasLoginForm || lower.includes('/login')) {
        state = 'login';
      } else if (feed || accountSwitcher || lower === 'https://www.facebook.com/' || lower.startsWith('https://www.facebook.com/?') || lower.includes('facebook.com/home')) {
        state = 'feed';
      }
      const loggedIn = state === 'feed';
      return JSON.stringify({ loggedIn, state, url: url.slice(0, 120), title: title.slice(0, 80) });
    })()`,
  );
  console.log(state);
} finally {
  cdp.close();
}
