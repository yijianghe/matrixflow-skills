#!/usr/bin/env node
/**
 * Facebook 发布框附件清理（2026-08-07 新增，配合 fb-post.mjs 使用）
 * 悬停图片区域 → 进入编辑模式 → 移除重复附件，直到只剩 target 张。
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

async function mouse(cdp, type, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

async function clickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x - 2, y - 2);
  await sleep(rand(60, 150));
  await mouse(cdp, "mousePressed", x, y);
  await sleep(rand(60, 140));
  await mouse(cdp, "mouseReleased", x, y);
}

async function main() {
  const profileId = process.argv[2];
  const target = Number.parseInt(process.argv[3], 10) || 1;
  if (!profileId) {
    console.error("用法: fb-fix-attachments.mjs <profileId> [目标附件数=1]");
    process.exit(1);
  }
  const dir = findProfileDir(profileId);
  if (!dir) throw new Error(`Profile ${profileId} is not running`);
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  const page = pages[0] || (Array.isArray(targets) ? targets.find((t) => t.type === "page") : null);
  if (!page) throw new Error("No facebook page");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront").catch(() => {});

    const imgs = () =>
      ev(
        cdp,
        `[...document.querySelectorAll('img')].filter(i => i.naturalWidth > 50).length`
      );

    for (let round = 0; round < 6; round++) {
      const count = await imgs();
      console.log(`[fix] 当前图片数: ${count}`);
      if (count <= target) break;

      // 悬停图片区域（中心 + 右上角）触发工具栏
      const areas = await ev(
        cdp,
        `(() => [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 50 && i.getBoundingClientRect().bottom > 0).map(i => { const r = i.getBoundingClientRect(); return [{x: r.x + r.width/2, y: r.y + r.height/2}, {x: r.x + r.width - 24, y: r.y + 24}]; }).flat())()`
      );
      if (!areas || !areas.length) break;
      let btn = null;
      for (const spot of areas) {
        await mouse(cdp, "mouseMoved", spot.x, spot.y);
        await sleep(600);
        btn = await ev(
          cdp,
          `(() => {
            const pick = [...document.querySelectorAll('div[role=button]')].find(e => {
              const a = (e.getAttribute('aria-label') || '');
              const r = e.getBoundingClientRect();
              return a.startsWith('移除') && r.bottom > 0 && r.top < innerHeight && r.width > 10;
            }) || [...document.querySelectorAll('div[role=button]')].find(e => {
              const a = (e.getAttribute('aria-label') || '');
              const r = e.getBoundingClientRect();
              return a === '全部编辑' && r.bottom > 0 && r.top < innerHeight && r.width > 10;
            });
            if (!pick) return null;
            const r = pick.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()`
        );
        if (btn) break;
      }

      if (!btn) {
        console.log("[fix] 未找到移除/编辑按钮，尝试点击图片中心");
        const spot = areas[0];
        if (spot) await clickAt(cdp, spot.x, spot.y);
        await sleep(1000);
        continue;
      }
      const { x: bx, y: by } = JSON.parse(btn);
      await clickAt(cdp, bx, by);
      console.log(`[fix] 已点击 ${JSON.stringify(btn)}`);
      await sleep(1500);
    }
    console.log(`[fix] 最终图片数: ${await imgs()}`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-fix] ${e.message}`);
  process.exit(1);
});
