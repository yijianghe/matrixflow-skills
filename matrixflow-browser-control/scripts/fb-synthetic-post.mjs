#!/usr/bin/env node
/**
 * 用 React 兼容的合成事件点击「发帖」按钮（Facebook 的 React 树可以识别
 * bubbles 的 mousedown/mouseup/click 序列），优先点击“含文案的弹窗”里的按钮。
 * 用法: node scripts/fb-synthetic-post.mjs <profileId> <probeText>
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
  const probeText = process.argv[3] || "一个人 = 一个团队";
  if (!profileId) {
    console.error("用法: fb-synthetic-post.mjs <profileId> [probeText]");
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
    let clicked = false;
    for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
      const res = await ev(
        cdp,
        `(() => {
          const vis = o => { const r = o.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 30; };
          const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(d => vis(d) && d.getBoundingClientRect().width > 300);
          const pick = dialogs.filter(d => (d.innerText || '').includes(${JSON.stringify(probeText)}))
            .concat(dialogs.filter(d => (d.innerText || '').includes('添加更多内容')))
            .concat(dialogs);
          for (const d of pick) {
            const btn = [...d.querySelectorAll('div[role=button]')]
              .filter(b => {
                const t = (b.textContent || '').trim();
                const a = (b.getAttribute('aria-label') || '').trim();
                return (t === '发帖' || t === 'Post' || a === '发帖' || a === 'Post') && vis(b) && b.getAttribute('aria-disabled') !== 'true';
              })
              .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
            if (btn) {
              const fire = (type, props) => btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...props }));
              fire('pointerdown', { button: 0 });
              fire('mousedown', { button: 0 });
              btn.focus();
              fire('pointerup', { button: 0 });
              fire('mouseup', { button: 0 });
              fire('click', { button: 0 });
              const r = btn.getBoundingClientRect();
              return JSON.stringify({ fired: true, x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }
          }
          return JSON.stringify({ fired: false });
        })()`
      );
      const r = JSON.parse(res);
      if (r.fired) {
        console.log(`[post] 合成事件已触发，位置 ${Math.round(r.x)},${Math.round(r.y)}`);
        clicked = true;
      }
      await sleep(1500);
    }
    console.log(clicked ? "[post] 已点击发帖，等待发布" : "[post] 未找到发帖按钮");
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-post-synth] ${e.message}`);
  process.exit(1);
});
