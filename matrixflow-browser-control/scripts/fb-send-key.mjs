#!/usr/bin/env node
/**
 * 向当前 Facebook 页面发送组合键（如 Ctrl+Enter 发布）。
 * 用法: node scripts/fb-send-key.mjs <profileId> --ctrl-enter
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveUserDataRoot() {
  if (process.env.MF_USER_DATA) return process.env.MF_USER_DATA;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  }
  return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
}

function findProfileDir(profileId) {
  const root = join(resolveUserDataRoot(), "Profiles");
  if (!existsSync(root)) return null;
  const stack = [root];
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
    ws.onerror = () => reject(new Error("CDP connect failed"));
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

async function main() {
  const profileId = process.argv[2];
  const mode = process.argv[3] === "--ctrl-enter" ? "ctrl-enter" : process.argv[3] === "--enter" ? "enter" : "esc";
  if (!profileId) {
    console.error("用法: fb-send-key.mjs <profileId> --ctrl-enter|--enter|--esc");
    process.exit(1);
  }
  const dir = findProfileDir(profileId);
  if (!dir) throw new Error(`Profile ${profileId} is not running`);
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  if (!page) throw new Error("No facebook page");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const key = (type, k, modifiers = 0) =>
      cdp.send("Input.dispatchKeyEvent", { type, key: k, code: k === "Enter" ? "Enter" : "Escape", windowsVirtualKeyCode: k === "Enter" ? 13 : 27, modifiers });
    if (mode === "ctrl-enter") {
      await key("keyDown", "Control", 2);
      await sleep(80);
      await key("keyDown", "Enter", 2);
      await key("keyUp", "Enter", 2);
      await sleep(80);
      await key("keyUp", "Control", 0);
      console.log("[key] Ctrl+Enter sent");
    } else if (mode === "enter") {
      await key("keyDown", "Enter", 0);
      await key("keyUp", "Enter", 0);
      console.log("[key] Enter sent");
    } else {
      await key("keyDown", "Escape", 0);
      await key("keyUp", "Escape", 0);
      console.log("[key] Escape sent");
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-key] ${e.message}`);
  process.exit(1);
});
