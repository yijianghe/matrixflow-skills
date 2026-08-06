#!/usr/bin/env node
/**
 * 逐行输入 Facebook 发布框文案（Input.insertText + Enter 换行，ProseMirror 兼容）。
 * 目标：最上层、隐私「公开」、内容为空的发布框。
 * 用法: node scripts/fb-type-prose.mjs <profileId> <textFile>
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
    console.error("用法: fb-type-prose.mjs <profileId> <textFile>");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const lines = text.split(/\r?\n/);
  const dir = findProfileDir(profileId);
  if (!dir) throw new Error(`Profile ${profileId} is not running`);
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  if (!page) throw new Error("No facebook page");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const probe = text.slice(0, 8);
    // 定位目标编辑器（隐私公开/内容为空的上层发布框），并真实点击聚焦
    const pos = await ev(
      cdp,
      `(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')]
          .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
        const target = dialogs.find(d => {
          const t = (d.innerText || '');
          const ce = d.querySelector('div[contenteditable=true]');
          return t.includes('公开') && !t.includes(${JSON.stringify(probe)}) && ce && ce.getBoundingClientRect().width > 50;
        }) || dialogs.find(d => {
          const t = (d.innerText || '');
          const ce = d.querySelector('div[contenteditable=true]');
          return !t.includes(${JSON.stringify(probe)}) && ce && ce.getBoundingClientRect().width > 50;
        });
        if (!target) return null;
        const ce = target.querySelector('div[contenteditable=true]');
        ce.focus();
        ce.innerHTML = '';
        const r = ce.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!pos) throw new Error("找不到目标编辑框");
    const p = JSON.parse(pos);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x - 2, y: p.y - 2 });
    await sleep(100);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(100);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(400);

    const enter = async () => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(rand(60, 140));
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(rand(120, 260));
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) {
        await cdp.send("Input.insertText", { text: line });
        await sleep(rand(60, 180));
      }
      if (i < lines.length - 1) await enter();
    }
    await sleep(600);
    const verify = await ev(
      cdp,
      `(() => {
        const el = [...document.querySelectorAll('div[contenteditable=true]')]
          .filter(e => e.getBoundingClientRect().width > 100)[0];
        return el ? JSON.stringify({ len: el.innerText.length, head: el.innerText.slice(0, 24), tail: el.innerText.slice(-28), hasProbe: el.innerText.includes(${JSON.stringify(probe)}) }) : 'none';
      })()`
    );
    console.log(`[type-prose] ${verify}`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-type-prose] ${e.message}`);
  process.exit(1);
});
