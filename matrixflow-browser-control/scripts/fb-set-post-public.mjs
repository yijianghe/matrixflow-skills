#!/usr/bin/env node
/**
 * 把已发布帖子的可见范围改成「公开」（2026-08-07）
 * 悬停帖子头部触发「编辑分享对象」→ 点公开 → 保存。
 * 用法: node scripts/fb-set-post-public.mjs <profileId> <帖子文案片段>
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
  await sleep(rand(80, 160));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(80, 160));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function main() {
  const profileId = process.argv[2];
  const probeText = process.argv[3];
  if (!profileId || !probeText) {
    console.error("用法: fb-set-post-public.mjs <profileId> <帖子文案片段>");
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
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });

    // 1) 回个人主页并滚动到目标帖子
    await cdp.send("Page.navigate", { url: "https://www.facebook.com/me" });
    await sleep(6000);
    let found = false;
    for (let round = 0; round < 6 && !found; round++) {
      found = (await ev(
        cdp,
        `(() => {
          const a = [...document.querySelectorAll('[role=article]')].find(x => (x.innerText || '').includes(${JSON.stringify(probeText)}));
          if (!a) return false;
          a.scrollIntoView({ block: 'center' });
          return true;
        })()`
      )) === true;
      if (!found) {
        await ev(cdp, `window.scrollBy(0, 700); 'ok'`);
        await sleep(1800);
      }
    }
    if (!found) throw new Error("找不到目标帖子");
    await sleep(1500);

    // 2) 调整滚动位置让帖子头部进入视口中部（实测这个位置「编辑分享对象」会直接出现）
    await ev(
      cdp,
      `(() => {
        const a = [...document.querySelectorAll('[role=article]')].find(x => (x.innerText || '').includes(${JSON.stringify(probeText)}));
        if (!a) return false;
        a.scrollIntoView({ block: 'center' });
        window.scrollBy(0, 150);
        a.setAttribute('data-mf-target', '1');
        return true;
      })()`
    );
    await sleep(1200);

    // 3) 找「编辑分享对象」→ 点击（同一会话内立即点，防漂移；失败重试一次）
    const btn = await ev(
      cdp,
      `(() => {
        const a = document.querySelector('[data-mf-target]');
        if (!a) return null;
        const ar = a.getBoundingClientRect();
        const el = [...document.querySelectorAll('div[role=button]')].find(e => {
          const a2 = (e.getAttribute('aria-label') || '');
          const r = e.getBoundingClientRect();
          return a2 === '编辑分享对象' && r.bottom > 0 && r.top < innerHeight && r.top > 80 && r.top < innerHeight - 60;
        });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!btn) throw new Error("找不到编辑分享对象按钮（未悬停触发？）");
    const b = JSON.parse(btn);
    await clickAt(cdp, b.x + rand(-1, 1), b.y + rand(-1, 1));
    await sleep(1500);
    // 若弹窗未开，重试一次
    let popupOpen = (await ev(cdp, `[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText || '').includes('谁能看到你的帖子'))`)) === true;
    if (!popupOpen) {
      const btn2 = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div[role=button]')].find(e => {
            const a2 = (e.getAttribute('aria-label') || '');
            const r = e.getBoundingClientRect();
            return a2 === '编辑分享对象' && r.bottom > 0 && r.top < innerHeight && r.top > 80;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (btn2) {
        const b2 = JSON.parse(btn2);
        await clickAt(cdp, b2.x, b2.y);
        await sleep(1500);
      }
    }

    // 4) 弹窗里点「公开」对应的单选（按行文本定位，不猜顺序）→ 保存
    const radio = await ev(
      cdp,
      `(() => {
        const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText || '').includes('谁能看到你的帖子'));
        if (!dlg) return null;
        const rows = [...dlg.querySelectorAll('div')]
          .filter(e => (e.innerText || '').trim().startsWith('公开') && e.getBoundingClientRect().width > 200)
          .sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (ra.width * ra.height) - (rb.width * rb.height);
          });
        const row = rows[0] || dlg;
        const r = row.querySelector('input[type=radio]') || dlg.querySelector('input[type=radio]');
        if (!r) return null;
        const rr = r.getBoundingClientRect();
        return JSON.stringify({ x: rr.x + rr.width / 2, y: rr.y + rr.height / 2, label: (row.innerText || '').trim().slice(0, 12) });
      })()`
    );
    if (!radio) throw new Error("隐私弹窗未打开");
    const r = JSON.parse(radio);
    await clickAt(cdp, r.x, r.y);
    await sleep(1000);
    const save = await ev(
      cdp,
      `(() => {
        const el = [...document.querySelectorAll('div[role=button]')].find(e => {
          const a = (e.getAttribute('aria-label') || '');
          const rr = e.getBoundingClientRect();
          return a === '保存隐私分享对象选择并关闭对话框' && rr.bottom > 0 && rr.top < innerHeight && rr.width > 30;
        });
        if (!el) return null;
        const rr = el.getBoundingClientRect();
        return JSON.stringify({ x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 });
      })()`
    );
    if (!save) throw new Error("找不到保存按钮");
    const s = JSON.parse(save);
    await clickAt(cdp, s.x, s.y);
    await sleep(3500);

    // 5) 验证
    const label = await ev(
      cdp,
      `(() => {
        const a = [...document.querySelectorAll('[role=article]')].find(x => (x.innerText || '').includes(${JSON.stringify(probeText)}));
        return a ? (a.innerText || '').replace(/\\s+/g, ' ').slice(0, 45) : '';
      })()`
    );
    const ok = /公开|Public/.test(label || "");
    console.log(`[set-public] ${label || "未找到"} ${ok ? "✅ 已公开" : "❌ 仍未公开"}`);
    if (!ok) process.exitCode = 1;
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-set-public] ${e.message}`);
  process.exit(1);
});
