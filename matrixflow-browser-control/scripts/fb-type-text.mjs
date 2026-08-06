#!/usr/bin/env node
/**
 * 向 Facebook 发布框输入文案（真实点击聚焦 + CDP Input.insertText）。
 * 用法: node scripts/fb-type-text.mjs <profileId> <textFile>
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
  const textFile = process.argv[3];
  if (!profileId || !textFile) {
    console.error("用法: fb-type-text.mjs <profileId> <textFile>");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const dir = findProfileDir(profileId);
  if (!dir) throw new Error(`Profile ${profileId} is not running`);
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  if (!page) throw new Error("No facebook page");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const pos = await ev(
      cdp,
      `(() => {
        const els = [...document.querySelectorAll('div[contenteditable=true]')]
          .map(e => ({ e, r: e.getBoundingClientRect() }))
          .filter(o => o.r.width > 100 && o.r.height > 20)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        const el = els[0] && els[0].e;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!pos) throw new Error("找不到编辑区");
    const p = JSON.parse(pos);
    // 真实点击聚焦
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x - 2, y: p.y - 2 });
    await sleep(100);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(100);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(400);
    // 干净重写：清空 → 光标归位 → 单次整段插入
    const ok = await ev(
      cdp,
      `(() => {
        const els = [...document.querySelectorAll('div[contenteditable=true]')]
          .map(e => ({ e, r: e.getBoundingClientRect() }))
          .filter(o => o.r.width > 100 && o.r.height > 20)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        const el = els[0] && els[0].e;
        if (!el) return false;
        el.focus();
        el.innerHTML = '';
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        const inserted = document.execCommand('insertText', false, ${JSON.stringify(text)});
        return inserted && el.textContent.length;
      })()`
    );
    console.log(`[type] 重写插入: ${ok}`);
    await sleep(500);
    const len = await ev(
      cdp,
      `(() => {
        const els = [...document.querySelectorAll('div[contenteditable=true]')]
          .map(e => ({ e, r: e.getBoundingClientRect() }))
          .filter(o => o.r.width > 100 && o.r.height > 20);
        const el = els[0] && els[0].e;
        return el ? el.textContent.length : -1;
      })()`
    );
    console.log(`[type] 输入完成，编辑区字符数: ${len}`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-type] ${e.message}`);
  process.exit(1);
});
