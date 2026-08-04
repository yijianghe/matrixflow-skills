#!/usr/bin/env node
/**
 * Human-like browsing for MatrixFlow browser (speed-optimized, tab-activating).
 *
 * Mimics a real person: random reading pauses, small scrolls, image switching,
 * comment scrolling, and a like on a chosen note. Handles sites that open note
 * links in new tabs (e.g. xiaohongshu): it follows the new tab, operates it,
 * closes it, and returns to the feed.
 *
 * Usage:
 *   node scripts/human-browse.mjs <profileSpec> <startUrl> [--notes 5] [--like 3] [--shot <png>]
 *
 *   --notes N    number of notes to browse (default 5)
 *   --like N     like the Nth note (1-based; 0 = do not like)
 *   --shot PATH  save a final screenshot (default D:\mf-human-browse.png)
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 19527;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

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

function resolveToken() {
  if (process.env.MF_LOCAL_API_TOKEN) return process.env.MF_LOCAL_API_TOKEN.trim();
  try {
    const p = join(resolveUserDataRoot(), "local-api-token.txt");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  } catch {}
  return "";
}

function baseUrl() {
  return (process.env.MF_LOCAL_API || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
}

async function api(pathname, { method = "GET", body } = {}) {
  const token = resolveToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-MatrixFlow-Token"] = token;
  const res = await fetch(baseUrl() + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API ${pathname} -> ${res.status}: ${json?.error?.message || res.statusText}`);
  return json;
}

function findProfileDir(profileId) {
  const profilesRoot = join(resolveUserDataRoot(), "Profiles");
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
    ws.onerror = () => reject(new Error(`CDP connect failed: ${wsUrl}`));
  });
  async function send(method, params = {}) {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    ws,
    send,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function pageTargets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return (Array.isArray(list) ? list : []).filter((t) => t.type === "page");
}

async function connectTab(profileSpec, tabSelector) {
  const at = String(profileSpec).lastIndexOf("@");
  const profile = at > 0 ? profileSpec.slice(0, at) : profileSpec;
  const pinSelector = at > 0 ? profileSpec.slice(at + 1) : "";
  let profileDir = findProfileDir(profile);
  if (!profileDir) {
    const running = await api("/api/v1/profiles/running");
    const id = (running.data || []).find((p) => p.profileId === profile)?.profileId;
    if (id) profileDir = findProfileDir(id);
  }
  if (!profileDir) throw new Error(`Profile ${profile} is not running`);
  const portFile = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8");
  const port = Number.parseInt(portFile.trim().split(/\r?\n/)[0], 10);
  const pages = await pageTargets(port);
  const nonInternal = pages.filter((t) => !/browser-start/.test(t.url || ""));
  let page;
  const target = tabSelector || pinSelector;
  if (target) {
    const idx = Number.parseInt(target, 10);
    page = Number.isFinite(idx)
      ? pages[idx]
      : pages.find((t) => (t.url || "").includes(target)) ||
        pages.find((t) => (t.title || "").includes(target));
  }
  page = page || nonInternal[0] || pages[0];
  if (!page) throw new Error("No page target");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => void 0);
  return { cdp, page, port, profile };
}

async function ev(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return null;
  return r.result?.value;
}

async function waitReady(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await ev(cdp, "document.readyState")) === "complete") return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

async function clickAt(cdp, x, y, jitter = 3) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 2, y: y - 2 });
  await sleep(rand(60, 180));
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: x + rand(-jitter, jitter),
    y: y + rand(-jitter, jitter),
    button: "left",
    clickCount: 1,
  });
  await sleep(rand(60, 140));
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x + rand(-jitter, jitter),
    y: y + rand(-jitter, jitter),
    button: "left",
    clickCount: 1,
  });
}

async function clickSelector(cdp, selector) {
  const rect = await ev(
    cdp,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`
  );
  if (!rect) return false;
  const { x, y } = JSON.parse(rect);
  await clickAt(cdp, x, y);
  return true;
}

async function switchImage(cdp) {
  const clicked = await ev(
    cdp,
    `(() => {
      const next = document.querySelector('.swiper-button-next, .next, [class*="arrow"][class*="right"], [class*="arrow"][class*="next"]');
      if (next) { const r = next.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); }
      const img = document.querySelector('.slide img, .swiper-slide-active img, .carousel img, .img-container img, .slide-content img');
      if (img) { const r = img.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width * 0.85, y: r.y + r.height/2}); }
      return null;
    })()`
  );
  if (!clicked) return false;
  const { x, y } = JSON.parse(clicked);
  await clickAt(cdp, x, y, 2);
  return true;
}

async function scrollComments(cdp, times) {
  for (let i = 0; i < times; i++) {
    await ev(
      cdp,
      `(() => {
        const c = document.querySelector('.comments-container, .comment-list, [class*="comment"]');
        if (c) c.scrollTop += 420; else window.scrollBy(0, 420);
        return 'ok';
      })()`
    );
    await sleep(rand(500, 1100));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  const startUrl = args[1];
  if (!profileSpec || !startUrl) {
    console.error("Usage: human-browse.mjs <profileSpec> <startUrl> [--notes 5] [--like 3] [--shot <png>]");
    process.exit(1);
  }
  let notes = 5;
  let likeIndex = 0;
  let shot = process.env.MF_SHOT || "D:\\mf-human-browse.png";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--notes") notes = Number.parseInt(args[++i], 10) || 5;
    if (args[i] === "--like") likeIndex = Number.parseInt(args[++i], 10) || 0;
    if (args[i] === "--shot") shot = args[++i] || shot;
  }

  // 1) 连接列表标签并打开起始页
  const feed = await connectTab(profileSpec, "");
  const { port, profile } = feed;
  const log = [];
  try {
    await feed.cdp.send("Page.navigate", { url: startUrl });
    await waitReady(feed.cdp, 25_000);
    await sleep(rand(1500, 2600));
    log.push({ step: "open", url: (await ev(feed.cdp, "location.href")) || startUrl });

    const visited = new Set();

    for (let n = 1; n <= notes; n++) {
      // 2) 每次重新在列表页找“未浏览过”的笔记卡片（点卡片本体，锚点矩形为 0）
      const rect = await ev(
        feed.cdp,
        `(() => {
          const cards = Array.from(document.querySelectorAll('section.note-item'));
          const seen = ${JSON.stringify([...visited])};
          const card = cards.find(c => {
            const a = c.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]');
            return a && !seen.includes((a.getAttribute('href') || '').split('?')[0]);
          }) || cards.find(c => !c.dataset.mfVisited);
          if (!card) return null;
          card.dataset.mfVisited = '1';
          const a = card.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]');
          const key = a ? (a.getAttribute('href') || '').split('?')[0] : (card.className || 'card');
          card.scrollIntoView({block:"center"});
          const r = card.getBoundingClientRect();
          return JSON.stringify({key, x: r.x + r.width/2, y: r.y + r.height/2});
        })()`
      );
      if (!rect) {
        log.push({ step: `note${n}`, result: "no-more-links" });
        break;
      }
      const { key, x, y } = JSON.parse(rect);
      visited.add(key);

      // 记录点击前的全部标签，用于识别“新增”的详情标签
      const beforeIds = new Set((await pageTargets(port)).map((t) => t.id));
      const feedUrlBefore = (await ev(feed.cdp, "location.href")) || "";
      await clickAt(feed.cdp, x, y);
      await sleep(rand(800, 1500));

      // 3) 检测详情页：当前标签跳转（主路径）或点击后新增的标签
      let detail = null;
      let newTab = false;
      for (let tries = 0; tries < 28; tries++) {
        const pages = await pageTargets(port);
        const newPage = pages.find((t) => !beforeIds.has(t.id) && t.type === "page");
        if (newPage) {
          detail = newPage;
          newTab = true;
          break;
        }
        const cur = await ev(feed.cdp, "location.href");
        if (cur && cur !== feedUrlBefore && !/browser-start/.test(cur) && !/\/explore\/?(\?|$)/.test(cur.split("?")[0])) {
          detail = feed.page;
          break;
        }
        await sleep(250);
      }

      if (!detail) {
        log.push({ step: `note${n}`, result: "detail-not-found" });
        await ev(feed.cdp, "history.back()").catch(() => {});
        await sleep(rand(1000, 1800));
        continue;
      }

      const cdp = newTab ? makeCdp(detail.webSocketDebuggerUrl) : feed.cdp;
      if (newTab) {
        await cdp.send("Runtime.enable");
        await cdp.send("Page.bringToFront").catch(() => void 0);
      }
      try {
        await waitReady(cdp, 18_000);
        await sleep(rand(1500, 3000));
        const title = (await ev(cdp, "document.title")) || "";
        log.push({ step: `note${n}`, opened: key, newTab, title });

        const imageSwitches = rand(1, 3);
        for (let i = 0; i < imageSwitches; i++) {
          const ok = await switchImage(cdp);
          await sleep(rand(700, 1600));
          if (!ok) break;
        }
        log.push({ step: `note${n}`, images: imageSwitches });

        await scrollComments(cdp, rand(1, 3));
        log.push({ step: `note${n}`, comments: "scrolled" });

        if (likeIndex === n) {
          const liked = await clickSelector(cdp, "#detail-like .like-wrapper, .engage-bar .like-wrapper, .like-wrapper");
          await sleep(rand(800, 1500));
          log.push({ step: `note${n}`, like: liked ? "clicked" : "missing" });
        }
      } finally {
        if (newTab) {
          // 4) 关闭详情标签，回到列表
          try {
            await fetch(`http://127.0.0.1:${port}/json/close/${detail.id}`);
          } catch {}
          cdp.close();
          await sleep(rand(1000, 1800));
        } else {
          await ev(cdp, "history.back()").catch(() => {});
          await sleep(rand(1200, 2000));
        }
      }
      // 列表页可能已懒加载，滚动一下继续
      await ev(feed.cdp, "window.scrollBy(0, 600)").catch(() => {});
      await sleep(rand(800, 1500));
    }

    const shotData = await feed.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(shot, Buffer.from(shotData.data, "base64"));
    log.push({ step: "screenshot", file: shot });
  } finally {
    feed.cdp.close();
  }
  console.log(JSON.stringify(log, null, 2));
}

main().catch((error) => {
  console.error(`[human-browse] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
