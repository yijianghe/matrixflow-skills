#!/usr/bin/env node
/**
 * 把当前 Facebook 发布框的可见范围设为「公开」（2026-08-07 新增）
 * 用法: node scripts/fb-set-public.mjs <profileId>
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

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 2, y: y - 2 });
  await sleep(rand(60, 150));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(60, 140));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function findVisible(cdp, jsFilter) {
  return await ev(cdp, `(() => { const el = [...document.querySelectorAll('div[role=button]')].find(e => { const r = e.getBoundingClientRect(); return ${jsFilter} && r.bottom > 0 && r.top < innerHeight && r.width > 20; }); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
}

async function main() {
  const profileId = process.argv[2];
  if (!profileId) {
    console.error("用法: fb-set-public.mjs <profileId>");
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
    await cdp.send("Page.bringToFront").catch(() => {});

    // 当前可见范围
    const current = await ev(
      cdp,
      `[...document.querySelectorAll('div[role=button]')].map(b => b.getAttribute('aria-label')||'').find(a => a.startsWith('编辑隐私设置')) || ''`
    );
    if (/公开|Public/.test(current || "")) {
      console.log(`[public] 已经是公开可见：${current}`);
      return;
    }
    console.log(`[public] 当前可见范围：${current}`);

    // 打开隐私弹窗
    const priv = await findVisible(
      cdp,
      `(e.getAttribute('aria-label') || '').startsWith('编辑隐私设置')`
    );
    if (!priv) throw new Error("找不到隐私按钮");
    let { x, y } = JSON.parse(priv);
    await clickAt(cdp, x, y);
    await sleep(1000);

    // 点击「公开」行（标签+说明合并的行，高 >50）
    const pub = await ev(
      cdp,
      `(() => {
        const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText || '').includes('谁能看到你的帖子'));
        const scope = dlg || document;
        const el = [...scope.querySelectorAll('div')]
          .filter(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return t.startsWith('公开') && r.width > 300 && r.height > 50 && r.bottom > 0 && r.top < innerHeight;
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (ra.width * ra.height) - (rb.width * rb.height);
          })[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!pub) throw new Error("找不到公开选项");
    const p = JSON.parse(pub);
    await clickAt(cdp, p.x, p.y);
    await sleep(1000);

    // 有的版本需要点「完成 / Done」确认
    for (let i = 0; i < 3; i++) {
      const done = await ev(
        cdp,
        `(() => {
          const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText || '').includes('谁能看到你的帖子'));
          const scope = dlg || document;
          const el = [...scope.querySelectorAll('div[role=button]')].find(e => {
            const t = (e.textContent || '').trim();
            const a = (e.getAttribute('aria-label') || '');
            const r = e.getBoundingClientRect();
            return (t === '完成' || t === 'Done' || a.startsWith('完成') || a === 'Done') && r.bottom > 0 && r.top < innerHeight && r.width > 30;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (!done) break;
      const d = JSON.parse(done);
      await clickAt(cdp, d.x, d.y);
      await sleep(900);
    }

    // 验证
    await sleep(800);
    const after = await ev(
      cdp,
      `[...document.querySelectorAll('div[role=button]')].map(b => b.getAttribute('aria-label')||'').find(a => a.startsWith('编辑隐私设置')) || ''`
    );
    const ok = /公开|Public/.test(after || "");
    console.log(`[public] 设置后可见范围：${after || "未知"} ${ok ? "✅ 已公开" : "❌ 未生效"}`);
    if (!ok) process.exitCode = 1;
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-set-public] ${e.message}`);
  process.exit(1);
});
