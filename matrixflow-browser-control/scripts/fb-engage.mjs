#!/usr/bin/env node
/**
 * Facebook 发布后真人式互动（2026-08-07 新增）
 * 点赞/浏览 ≥3 条帖子 + 搜索话题浏览 + 加好友 + 加入相关小组。
 * 所有动作随机化（等待时长、滚动距离、目标选择），每次行为不同。
 *
 * 用法: node scripts/fb-engage.mjs <profileId> [--likes 3] [--topic "digital marketing"]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const TOPICS = ["digital marketing", "ecommerce tips", "social media growth", "跨境电商", "多账号运营", "fingerprint browser", "online business"];

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
  await sleep(rand(80, 200));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(80, 180));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function scrollRandom(cdp) {
  const delta = rand(400, 1100) * (Math.random() > 0.15 ? 1 : -1);
  await ev(cdp, `window.scrollBy(0, ${delta}); 'ok'`);
  await sleep(rand(1500, 3500));
}

async function main() {
  const args = process.argv.slice(2);
  const profileId = args[0];
  let likesTarget = 3;
  let topic = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--likes") likesTarget = Number.parseInt(args[++i], 10) || 3;
    else if (args[i] === "--topic") topic = args[++i] || "";
  }
  if (!profileId) {
    console.error("用法: fb-engage.mjs <profileId> [--likes 3] [--topic 关键词]");
    process.exit(1);
  }
  const finalTopic = topic || TOPICS[Math.floor(Math.random() * TOPICS.length)];
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
    const report = [];

    // 1) 首页刷动态 + 点赞 ≥ N 条（随机选帖、随机等待）
    await cdp.send("Page.navigate", { url: "https://www.facebook.com/" });
    await sleep(rand(4000, 6000));
    let liked = 0;
    const likedSet = new Set();
    for (let round = 0; round < 12 && liked < likesTarget; round++) {
      await scrollRandom(cdp);
      const btn = await ev(
        cdp,
        `(() => {
          const arts = [...document.querySelectorAll('[role=article]')].filter(a => a.getBoundingClientRect().bottom > 0 && a.getBoundingClientRect().top < innerHeight);
          if (!arts.length) return null;
          const a = arts[Math.floor(Math.random() * arts.length)];
          const like = [...a.querySelectorAll('div[role=button]')].find(b => {
            const t = (b.textContent || '').trim();
            const al = (b.getAttribute('aria-label') || '');
            const r = b.getBoundingClientRect();
            return (t === '赞' || al === '赞' || al === 'Like') && r.bottom > 0 && r.top < innerHeight && r.width > 20 && r.width < 200;
          });
          if (!like) return null;
          const r = like.getBoundingClientRect();
          const key = Math.round(r.x + r.y);
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, key });
        })()`
      );
      if (!btn) continue;
      const b = JSON.parse(btn);
      if (likedSet.has(b.key)) continue;
      likedSet.add(b.key);
      await clickAt(cdp, b.x, b.y);
      await sleep(rand(1200, 2600));
      liked++;
      console.log(`[engage] 点赞 ${liked}/${likesTarget}`);
    }
    report.push(`点赞 ${liked}/${likesTarget}`);

    // 2) 搜索话题并浏览（滚动阅读几条）
    const searchUrl = `https://www.facebook.com/search/posts?q=${encodeURIComponent(finalTopic)}`;
    await cdp.send("Page.navigate", { url: searchUrl });
    await sleep(rand(4500, 6500));
    let browsed = 0;
    for (let round = 0; round < 4; round++) {
      await scrollRandom(cdp);
      browsed++;
    }
    report.push(`搜索话题「${finalTopic}」浏览 ${browsed} 屏`);

    // 3) 加好友（好友推荐页点一次「添加好友」）
    await cdp.send("Page.navigate", { url: "https://www.facebook.com/friends/suggestions/" });
    await sleep(rand(4000, 6000));
    let friendAdded = false;
    for (let round = 0; round < 4 && !friendAdded; round++) {
      const addBtn = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div[role=button]')].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return (t === '添加好友' || t === 'Add Friend') && r.bottom > 0 && r.top < innerHeight && r.width > 40;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (addBtn) {
        const b = JSON.parse(addBtn);
        await clickAt(cdp, b.x, b.y);
        await sleep(rand(1500, 2500));
        friendAdded = true;
      } else {
        await scrollRandom(cdp);
      }
    }
    report.push(friendAdded ? "已发出 1 个好友请求" : "未找到可添加的好友");

    // 4) 加入相关小组（搜索小组 → 加入一个）
    const groupUrl = `https://www.facebook.com/search/groups?q=${encodeURIComponent(finalTopic)}`;
    await cdp.send("Page.navigate", { url: groupUrl });
    await sleep(rand(4500, 6500));
    let groupJoined = false;
    for (let round = 0; round < 4 && !groupJoined; round++) {
      const joinBtn = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div[role=button]')].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return (t === '加入群组' || t === 'Join Group' || t === '加入小组') && r.bottom > 0 && r.top < innerHeight && r.width > 40;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (joinBtn) {
        const b = JSON.parse(joinBtn);
        await clickAt(cdp, b.x, b.y);
        await sleep(rand(1500, 2500));
        groupJoined = true;
      } else {
        await scrollRandom(cdp);
      }
    }
    report.push(groupJoined ? "已加入 1 个相关小组" : "未找到可加入的小组");

    console.log(`[engage] 完成: ${report.join(" | ")}`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-engage] ${e.message}`);
  process.exit(1);
});
