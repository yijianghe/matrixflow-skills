#!/usr/bin/env node
/**
 * 直接点击页面中标记了 data-mf-click 的元素中心（不滚动、不重排），
 * 用于解决 Facebook 双弹窗渲染导致的误点问题。
 * 用法: node scripts/fb-click-element.mjs <profileId> <selector>
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

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

async function ev(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return null;
  return r.result?.value;
}

async function main() {
  const profileId = process.argv[2];
  const selector = process.argv[3];
  if (!profileId || !selector) {
    console.error("用法: fb-click-element.mjs <profileId> <selector>");
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
    const coords = await ev(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom });
      })()`
    );
    if (!coords) throw new Error(`元素不存在: ${selector}`);
    const c = JSON.parse(coords);
    console.log(`[click] ${selector} -> x=${Math.round(c.x)} y=${Math.round(c.y)} (${Math.round(c.w)}x${Math.round(c.h)}, top=${Math.round(c.top)}, bottom=${Math.round(c.bottom)})`);
    if (c.top < 0 || c.bottom > innerHeight_) throw new Error("元素不在视口内");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x - 2, y: c.y - 2 });
    await sleep(rand(80, 180));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await sleep(rand(80, 160));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
    console.log("[click] 已点击");
  } finally {
    cdp.close();
  }
}

const innerHeight_ = 9999;
main().catch((e) => {
  console.error(`[fb-click] ${e.message}`);
  process.exit(1);
});
