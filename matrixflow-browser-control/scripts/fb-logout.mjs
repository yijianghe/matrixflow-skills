#!/usr/bin/env node
/**
 * Facebook 退出（清 facebook 相关 cookie + 回登录页）。
 * 用法: node fb-logout.mjs <profileId>
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const profileSpec = process.argv[2];
if (!profileSpec) {
  console.error("用法: fb-logout.mjs <profileId>");
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
        if (entry.name === profileId && existsSync(join(full, "DevToolsActivePort"))) return full;
        stack.push(full);
      }
    }
  }
  return null;
}

const profileDir = findProfileDir(profileSpec);
if (!profileDir) {
  console.error(`Profile ${profileSpec} has no DevToolsActivePort. Is it running?`);
  process.exit(1);
}
const [port] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = (Array.isArray(list) ? list : []).filter((t) => t.type === "page").find((t) => !/browser-start/.test(t.url || "")) || (Array.isArray(list) ? list : []).find((t) => t.type === "page");
if (!page) {
  console.error("No page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("CDP connect failed"));
});
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
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  await send("Network.enable");
  for (const url of [
    "https://www.facebook.com/",
    "https://facebook.com/",
    "https://m.facebook.com/",
    "https://web.facebook.com/",
    "https://www.facebook.com/login",
  ]) {
    await send("Network.deleteCookies", { url }).catch(() => undefined);
  }
  // 兜底：按 name/domain 删 facebook 相关 cookie
  const { cookies } = await send("Network.getAllCookies").catch(() => ({ cookies: [] }));
  for (const c of cookies || []) {
    if (/facebook|fbcdn/i.test(c.domain)) {
      await send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path || "/" }).catch(() => undefined);
    }
  }
  await send("Page.navigate", { url: "https://www.facebook.com/login" });
  console.log(JSON.stringify({ ok: true, profile: profileSpec, state: "logged-out" }));
} finally {
  ws.close();
}
