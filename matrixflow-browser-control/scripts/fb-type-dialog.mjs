#!/usr/bin/env node
/**
 * 向指定条件的 Facebook 发布框输入文案。
 * 目标：最上层、隐私已是「公开」、但内容为空的发布框（解决双发布框叠层问题）。
 * 用法: node scripts/fb-type-dialog.mjs <profileId> <textFile>
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

async function ev(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return null;
  return r.result?.value;
}

async function main() {
  const profileId = process.argv[2];
  const textFile = process.argv[3];
  if (!profileId || !textFile) {
    console.error("用法: fb-type-dialog.mjs <profileId> <textFile>");
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
    const res = await ev(
      cdp,
      `(() => {
        const probe = ${JSON.stringify(text.slice(0, 8))};
        const dialogs = [...document.querySelectorAll('[role=dialog]')]
          .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
        // 目标：含「公开」隐私、不含我们的文案、有内容编辑区的发布框（通常是叠在上层那个）
        const target = dialogs.find(d => {
          const t = (d.innerText || '');
          const ce = d.querySelector('div[contenteditable=true]');
          return t.includes('公开') && !t.includes(probe) && ce && ce.getBoundingClientRect().width > 50;
        }) || dialogs.find(d => {
          const t = (d.innerText || '');
          const ce = d.querySelector('div[contenteditable=true]');
          return !t.includes(probe) && ce && ce.getBoundingClientRect().width > 50;
        });
        if (!target) return JSON.stringify({ ok: false, reason: 'no-target-dialog' });
        const el = target.querySelector('div[contenteditable=true]');
        el.focus();
        el.innerHTML = '';
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, ${JSON.stringify(text)});
        const len = el.textContent.length;
        return JSON.stringify({ ok: true, len, hasProbe: el.textContent.includes(probe), tail: el.textContent.slice(-20) });
      })()`
    );
    console.log(`[type-dialog] ${res}`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-type-dialog] ${e.message}`);
  process.exit(1);
});
