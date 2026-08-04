#!/usr/bin/env node
/**
 * 小红书养号 / 截留 陪跑脚本
 *
 * 模拟真人给账号打标签、找爆款、评论区截留（种草评论）。一次连接、自动激活标签页。
 *
 * 用法：
 *   node scripts/xhs-marketing.mjs <profileSpec> tag <关键词...> [--notes N]
 *   node scripts/xhs-marketing.mjs <profileSpec> pick <关键词...> [--top N]
 *   node scripts/xhs-marketing.mjs <profileSpec> intercept <笔记URL> --comment <种草话术>
 *   node scripts/xhs-marketing.mjs <profileSpec> full <关键词...> --comment <种草话术> [--notes N] [--top N]
 *
 * 动作：
 *   tag        打标签：搜索关键词并逐篇浏览（训练推荐算法）
 *   pick       选爆款：搜索并按点赞数排序输出 Top N
 *   intercept  截留：在指定笔记下发布一条种草评论
 *   full       完整流程：搜索 → 选爆款 → 打开 → 评论区截留
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

async function connect(profileSpec) {
  const at = String(profileSpec).lastIndexOf("@");
  const profile = at > 0 ? profileSpec.slice(0, at) : profileSpec;
  const selector = at > 0 ? profileSpec.slice(at + 1) : "";
  let profileDir = findProfileDir(profile);
  if (!profileDir) {
    const full = await api("/api/v1/profiles");
    const items = full.data?.items || full.data || [];
    const item = items.find((p) => p.id === profile || p.name === profile);
    if (item) profileDir = findProfileDir(item.id);
  }
  if (!profileDir) throw new Error(`Profile ${profile} is not running`);
  const portFile = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8");
  const port = Number.parseInt(portFile.trim().split(/\r?\n/)[0], 10);
  const pages = await pageTargets(port);
  const nonInternal = pages.filter((t) => !/browser-start/.test(t.url || ""));
  let page;
  if (selector) {
    const idx = Number.parseInt(selector, 10);
    page = Number.isFinite(idx)
      ? pages[idx]
      : pages.find((t) => (t.url || "").includes(selector)) ||
        pages.find((t) => (t.title || "").includes(selector));
  }
  page = page || nonInternal[0] || pages[0];
  if (!page) throw new Error("No page target");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => void 0);
  return { cdp, page, port };
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

function parseCount(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  const m = t.match(/([\d.]+)\s*([万wW]?)/);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]) || 0;
  return /万|w/i.test(m[2]) ? Math.round(n * 10000) : Math.round(n);
}

async function collectNotes(cdp, max = 20) {
  const raw = await ev(
    cdp,
    `(() => {
      const out = [];
      document.querySelectorAll('section.note-item').forEach(card => {
        const a = card.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]');
        const titleEl = card.querySelector('.title');
        const likeEl = card.querySelector('.like-wrapper .count');
        out.push({
          href: a ? a.getAttribute('href') : '',
          title: titleEl ? titleEl.textContent.trim().slice(0, 40) : '',
          likeText: likeEl ? likeEl.textContent.trim() : ''
        });
      });
      return JSON.stringify(out.slice(0, ${max}));
    })()`
  );
  return raw ? JSON.parse(raw) : [];
}

async function search(cdp, keyword) {
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
  await cdp.send("Page.navigate", { url });
  await waitReady(cdp, 20_000);
  await sleep(rand(1800, 3200));
}

async function openNote(cdp, href) {
  const full = href.startsWith("http") ? href : `https://www.xiaohongshu.com${href}`;
  await cdp.send("Page.navigate", { url: full });
  await waitReady(cdp, 20_000);
  await sleep(rand(1800, 3000));
}

async function postComment(cdp, text) {
  // 找到评论输入框并聚焦
  const focused = await ev(
    cdp,
    `(() => {
      const el = document.querySelector('#comment-input, .comment-input, textarea[placeholder*="评论"], [contenteditable="true"][class*="comment"], .editor[contenteditable="true"]');
      if (!el) return false;
      el.focus();
      el.click();
      return true;
    })()`
  );
  if (!focused) return { ok: false, reason: "comment-input-not-found" };
  await sleep(rand(500, 1000));
  await cdp.send("Input.insertText", { text: String(text) });
  await sleep(rand(600, 1200));
  // 点发布
  const rect = await ev(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll('button, [role="button"]')].find(b => (b.textContent||'').replace(/\\s+/g,'').includes('发布') && b.offsetParent !== null);
      if (!btn) return null;
      btn.scrollIntoView({block:'center'});
      const r = btn.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`
  );
  if (!rect) return { ok: false, reason: "publish-button-not-found" };
  const { x, y } = JSON.parse(rect);
  await clickAt(cdp, x, y);
  await sleep(rand(1200, 2000));
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  const action = args[1];
  if (!profileSpec || !action) {
    console.error("用法: xhs-marketing.mjs <profileSpec> tag|pick|intercept|full <关键词...> [--comment 话术] [--notes N] [--top N]");
    process.exit(1);
  }
  let comment = "";
  let notes = 5;
  let top = 3;
  const keywords = [];
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--comment") comment = args[++i] || "";
    else if (args[i] === "--notes") notes = Number.parseInt(args[++i], 10) || 5;
    else if (args[i] === "--top") top = Number.parseInt(args[++i], 10) || 3;
    else keywords.push(args[i]);
  }
  if (keywords.length === 0) {
    console.error("请至少提供一个搜索关键词");
    process.exit(1);
  }

  const { cdp, port } = await connect(profileSpec);
  const log = [];
  try {
    if (action === "tag") {
      for (const kw of keywords) {
        await search(cdp, kw);
        const cards = await collectNotes(cdp, notes + 3);
        let opened = 0;
        for (const card of cards) {
          if (opened >= notes) break;
          if (!card.href) continue;
          await openNote(cdp, card.href);
          await sleep(rand(1800, 3000));
          await ev(cdp, "history.back()");
          await waitReady(cdp, 15_000);
          await sleep(rand(1200, 2200));
          opened += 1;
        }
        log.push({ keyword: kw, browsed: opened });
      }
    } else if (action === "pick") {
      for (const kw of keywords) {
        await search(cdp, kw);
        const cards = (await collectNotes(cdp, 30))
          .map((c) => ({ ...c, likes: parseCount(c.likeText) }))
          .sort((a, b) => b.likes - a.likes)
          .slice(0, top);
        log.push({ keyword: kw, top: cards });
      }
    } else if (action === "intercept") {
      const noteUrl = keywords[0];
      if (!comment) {
        console.error("intercept 需要 --comment 种草话术");
        process.exit(1);
      }
      await openNote(cdp, noteUrl);
      const result = await postComment(cdp, comment);
      log.push({ note: noteUrl, comment: comment.slice(0, 40), result });
    } else if (action === "full") {
      if (!comment) {
        console.error("full 需要 --comment 种草话术");
        process.exit(1);
      }
      for (const kw of keywords) {
        await search(cdp, kw);
        const cards = (await collectNotes(cdp, 30))
          .map((c) => ({ ...c, likes: parseCount(c.likeText) }))
          .sort((a, b) => b.likes - a.likes);
        const target = cards[0];
        if (!target || !target.href) {
          log.push({ keyword: kw, result: "no-note" });
          continue;
        }
        await openNote(cdp, target.href);
        const result = await postComment(cdp, comment);
        log.push({ keyword: kw, target: target.title, likes: target.likes, result });
        await sleep(rand(1500, 2500));
      }
    } else {
      throw new Error(`未知动作: ${action}`);
    }
    console.log(JSON.stringify(log, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(`[xhs-marketing] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
