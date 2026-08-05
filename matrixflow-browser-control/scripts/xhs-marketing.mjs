#!/usr/bin/env node
/**
 * 小红书养号 / 截留 陪跑脚本
 *
 * 模拟真人给账号打标签、找爆款、评论区截留（种草评论）。一次连接、自动激活标签页。
 *
 * 用法：
 *   node scripts/xhs-marketing.mjs <profileSpec> tag <关键词...> [--notes N]
 *   node scripts/xhs-marketing.mjs <profileSpec> pick <关键词...> [--top N]
 *   node scripts/xhs-marketing.mjs <profileSpec> intercept <关键词> --title <标题片段> --comment <种草话术>
 *   node scripts/xhs-marketing.mjs <profileSpec> scan <关键词...> --top N [--city 城市]    截流扫描：读同行评论区，分辨意向客户
 *   node scripts/xhs-marketing.mjs <profileSpec> reply <关键词> --to <评论片段> --comment <回复话术> [--title <标题片段>]
 *   node scripts/xhs-marketing.mjs <profileSpec> reference <关键词...> --top N              爆改参考：收集爆款结构+评论区高频问题
 *   node scripts/xhs-marketing.mjs <profileSpec> full <关键词...> --comment <种草话术> [--notes N] [--top N]
 *   node scripts/xhs-marketing.mjs <profileSpec> inbox                                 打开网页版消息页，读未读私信/会话
 *
 * 动作：
 *   tag        打标签：搜索关键词并逐篇浏览（训练推荐算法）
 *   pick       选爆款：搜索并按点赞数排序输出 Top N
 *   intercept  截留：在指定笔记下发布一条种草评论
 *   full       完整流程：搜索 → 选爆款 → 打开 → 评论区截留
 *   scan       截流扫描：找同行笔记，读评论区，标记求地址/求推荐/问价格等意向客户
 *   reply      评论区回复截留：给目标评论种草式回复
 *   reference  爆改参考：收集爆款标题/点赞/评论区问题，供改写发布
 *   inbox      私信：打开网页版消息页，输出会话/未读私信文本（回复私信用 mf-browser click/type 操作）
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

async function openCardAndFollow(cdp, port, titleMatch) {
  // 记录点击前的标签，识别“新标签打开”的情况
  const beforeIds = new Set((await pageTargets(port)).map((t) => t.id));
  const feedUrl = (await ev(cdp, "location.href")) || "";
  const rect = await ev(
    cdp,
    `(() => {
      const cards = Array.from(document.querySelectorAll('section.note-item'));
      const el = (${JSON.stringify(titleMatch)}
        ? cards.find(c => ((c.querySelector('.title')||{}).textContent||'').includes(${JSON.stringify(titleMatch)}))
        : null) || cards[0];
      if (!el) return null;
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`
  );
  if (!rect) return false;
  const { x, y } = JSON.parse(rect);
  await clickAt(cdp, x, y);

  // 等待详情：新标签或同标签跳转
  let noteCdp = cdp;
  let newTab = false;
  let targetId = null;
  let entered = false;
  for (let i = 0; i < 40; i++) {
    const pages = await pageTargets(port);
    const newPage = pages.find((t) => !beforeIds.has(t.id) && t.type === "page");
    if (newPage) {
      const nc = makeCdp(newPage.webSocketDebuggerUrl);
      await nc.send("Runtime.enable").catch(() => void 0);
      await nc.send("Page.bringToFront").catch(() => void 0);
      noteCdp = nc;
      newTab = true;
      entered = true;
      targetId = newPage.id;
      break;
    }
    const cur = (await ev(cdp, "location.href")) || "";
    if (cur !== feedUrl && /\/explore\/\w{20,}|\/discovery\/item\/\w{20,}/.test(cur)) {
      entered = true;
      break;
    }
    await sleep(250);
  }
  if (!entered) return false;
  await waitReady(noteCdp, 10_000);
  await sleep(rand(1800, 3000));
  return { cdp: noteCdp, newTab, targetId, port };
}

async function openNoteByTitle(cdp, port, keyword, titleMatch) {
  await search(cdp, keyword);
  let cards = [];
  for (let i = 0; i < 3; i++) {
    cards = await collectNotes(cdp, 30);
    if (cards.length > 0) break;
    await sleep(1200);
  }
  const card = titleMatch ? cards.find((c) => c.title.includes(titleMatch)) : null;
  const target = card || cards[0];
  console.error(`[xhs] keyword=${keyword} cards=${cards.length} match=${card ? "yes" : "no"} target=${target ? target.title : "none"}`);
  if (!target) return false;
  return openCardAndFollow(cdp, port, target.title);
}

async function postComment(cdp, text) {
  // 找到评论输入框并聚焦
  const focused = await ev(
    cdp,
    `(() => {
      const el = document.querySelector('#comment-input, .comment-input, .content-input, textarea[placeholder*="评论"], [contenteditable="true"][class*="comment"], .editor[contenteditable="true"], .comment-box [contenteditable="true"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`
  );
  if (!focused) return { ok: false, reason: "comment-input-not-found" };
  const { x, y } = JSON.parse(focused);
  await clickAt(cdp, x, y); // 真实点击评论框，触发 React 聚焦
  await sleep(rand(500, 1000));
  await cdp.send("Input.insertText", { text: String(text) });
  await sleep(rand(600, 1200));
  // 校验文字真的进入了输入框
  const entered = await ev(cdp, `(document.querySelector('.content-input, .comment-input')||{}).textContent || ''`);
  if (!entered || !String(entered).includes(String(text).slice(0, 8))) {
    return { ok: false, reason: "text-not-entered", entered: String(entered || "").slice(0, 30) };
  }
  // 点发布
  const rect = await ev(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll('button, [role="button"]')].find(b => {
        const t = (b.textContent||'').replace(/\\s+/g,'');
        return /^(发布|发送)$/.test(t) && b.offsetParent !== null;
      }) || [...document.querySelectorAll('[class*="comment-submit"], [class*="submit"][class*="comment"]')].find(b => b.offsetParent !== null);
      if (!btn) return null;
      btn.scrollIntoView({block:'center'});
      const r = btn.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`
  );
  if (!rect) return { ok: false, reason: "publish-button-not-found" };
  const pb = JSON.parse(rect);
  await clickAt(cdp, pb.x, pb.y);
  await sleep(rand(1200, 2000));
  // 校验：提交后输入框应被清空（说明已发出）
  const after = await ev(cdp, `(document.querySelector('.content-input, .comment-input')||{}).textContent || ''`);
  return { ok: String(after || "").trim() === "", submitted: true };
}

async function likeOrCollect(cdp) {
  // 低频互动：约 35% 点赞、15% 收藏，防查重
  const roll = Math.random();
  if (roll > 0.5) return { action: "none" };
  const like = roll <= 0.35;
  const selector = like
    ? "#detail-like .like-wrapper, .engage-bar .like-wrapper, .like-wrapper"
    : ".collect-wrapper, #collect-btn, [class*=collect]";
  const rect = await ev(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`
  );
  if (!rect) return { action: "none" };
  const { x, y } = JSON.parse(rect);
  await clickAt(cdp, x, y);
  await sleep(rand(900, 1800));
  return { action: like ? "like" : "collect" };
}

async function collectComments(cdp) {
  const raw = await ev(
    cdp,
    `(() => {
      const out = [];
      document.querySelectorAll('.comment-item, .comments-container .comment').forEach(c => {
        const textEl = c.querySelector('.content, [class*=content]');
        if (!textEl) return;
        const text = textEl.textContent.trim();
        if (!text) return;
        out.push({ text: text.slice(0, 80) });
      });
      return JSON.stringify(out.slice(0, 30));
    })()`
  );
  return raw ? JSON.parse(raw) : [];
}

// 展开二级/三级评论（点"展开N条回复"和嵌套"查看回复"），让 scan 能读到更深层的意向评论
async function expandReplies(cdp) {
  for (let i = 0; i < 8; i++) {
    const clicked = await ev(
      cdp,
      `(() => {
        const btns = [...document.querySelectorAll('.show-more, [class*="show-more"], [class*="view-replies"], [class*="reply"] [class*="more"]')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight;
        });
        if (!btns.length) return false;
        const b = btns[Math.floor(Math.random() * btns.length)];
        b.scrollIntoView({ block: 'center', behavior: 'instant' });
        b.click();
        return true;
      })()`
    );
    if (!clicked) break;
    await sleep(800);
  }
}

function classifyIntent(text) {
  const t = String(text || "").trim();
  // 只把“像提问”的评论当意向客户，减少把建议/分享误判为客户
  const looksLikeQuestion =
    /[?？]$/.test(t) ||
    /^(求|哪里|在哪|怎么|多少钱|有没有|能|可以|适合|想做|想学|带带|求带)/.test(t);
  if (!looksLikeQuestion) return "";
  if (/(\u5730\u5740|\u5728\u54ea|\u54ea\u91cc|\u4f4d\u7f6e|\u6c42\u5730\u5740|\u600e\u4e48\u627e)/.test(t)) return "ask-address";
  if (/(\u6c42\u63a8\u8350|\u63a8\u8350\u4e00\u4e0b|\u6709\u6ca1\u6709\u63a8\u8350|\u5b89\u5229)/.test(t)) return "ask-recommend";
  if (/(\u591a\u5c11\u94b1|\u4ef7\u683c|\u600e\u4e48\u4e70|\u94fe\u63a5|\u600e\u4e48\u8054\u7cfb|\u8d5a\u591a\u5c11|\u80fd\u8d5a|\u6210\u672c)/.test(t)) return "ask-price";
  if (/(\u6c42\u5e26|\u5e26\u5e26\u6211|\u600e\u4e48\u5f00\u59cb|\u60f3\u505a|\u60f3\u5b66|\u9002\u5408\u65b0\u624b|\u6c42\u6559\u7a0b|\u60f3\u8fdb\u5165)/.test(t)) return "intent";
  return "";
}

function isLocalTitle(title, city) {
  if (!city) return null;
  return String(title || "").includes(city);
}

async function replyComment(cdp, commentFragment, replyText) {
  // 找到目标评论的"回复"按钮并点击
  const rect = await ev(
    cdp,
    `(() => {
      const items = Array.from(document.querySelectorAll('.comment-item, .comments-container .comment'));
      const target = items.find(c => ((c.querySelector('.content, [class*=content]')||{}).textContent||'').includes(${JSON.stringify(commentFragment)})) || items.find(c => ((c.querySelector('.content, [class*=content]')||{}).textContent||'').includes(${JSON.stringify(String(commentFragment).slice(0, 6))}));
      if (!target) return null;
      const btn = [...target.querySelectorAll('button, [role=button], [class*=reply]')].find(b => /^\u56de\u590d$|^\u56de\u590d\u4ed6$|^\u56de\u590d\u5979$/.test((b.textContent||'').replace(/\\s+/g,'')) || /reply/i.test(String(b.className))) || target.querySelector('[class*=reply]');
      if (!btn) return null;
      btn.scrollIntoView({block:'center'});
      const r = btn.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`
  );
  if (!rect) return { ok: false, reason: "reply-button-not-found" };
  const { x, y } = JSON.parse(rect);
  await clickAt(cdp, x, y);
  await sleep(rand(600, 1100));
  // 输入回复并发布
  const result = await postComment(cdp, replyText);
  return result;
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
    else if (["--city", "--title", "--to", "--industry"].includes(args[i])) i++;
    else keywords.push(args[i]);
  }
  if (keywords.length === 0 && action !== "inbox") {
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
          const res = await openCardAndFollow(cdp, port, card.title);
          if (!res) continue;
          await sleep(rand(1800, 3000));
          await likeOrCollect(res.cdp); // 随机点赞/收藏，低频差异化
          if (res.newTab) {
            try {
              await fetch(`http://127.0.0.1:${port}/json/close/${res.targetId}`);
            } catch {}
            res.cdp.close();
          } else {
            await ev(res.cdp, "history.back()").catch(() => {});
            await waitReady(res.cdp, 15_000);
          }
          await sleep(rand(1200, 2200));
          opened += 1;
        }
        log.push({ keyword: kw, browsed: opened });
      }
    } else if (action === "pick") {
      for (const kw of keywords) {
        await search(cdp, kw);
        const kwCore = String(kw).replace(/\s/g, "");
        const kwFirst = String(kw).split(/\s/)[0];
        const cards = (await collectNotes(cdp, 30))
          .filter((c) => !kwCore || (c.title || "").includes(kwCore) || (c.title || "").includes(kwFirst))
          .map((c) => ({ ...c, likes: parseCount(c.likeText) }))
          .sort((a, b) => b.likes - a.likes)
          .slice(0, top);
        log.push({ keyword: kw, top: cards });
      }
    } else if (action === "intercept") {
      const keyword = keywords[0];
      const titleMatch = (() => {
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--title") return args[i + 1] || "";
        }
        return "";
      })();
      if (!comment) {
        console.error("intercept 需要 --comment 种草话术");
        process.exit(1);
      }
      const opened = await openNoteByTitle(cdp, port, keyword, titleMatch);
      if (!opened) {
        console.error(`未找到笔记: ${keyword} / ${titleMatch}`);
        process.exit(1);
      }
      const result = await postComment(opened.cdp, comment);
      log.push({ keyword, title: titleMatch, comment: comment.slice(0, 40), result });
      if (opened.newTab) {
        try {
          await fetch(`http://127.0.0.1:${port}/json/close/${opened.targetId}`);
        } catch {}
        opened.cdp.close();
      }
    } else if (action === "full") {
      if (!comment) {
        console.error("full 需要 --comment 种草话术");
        process.exit(1);
      }
      for (const kw of keywords) {
        await search(cdp, kw);
        const kwCore = String(kw).replace(/\s/g, "");
        const kwFirst = String(kw).split(/\s/)[0];
        const cards = (await collectNotes(cdp, 30))
          .filter((c) => !kwCore || (c.title || "").includes(kwCore) || (c.title || "").includes(kwFirst))
          .map((c) => ({ ...c, likes: parseCount(c.likeText) }))
          .sort((a, b) => b.likes - a.likes);
        const target = cards[0];
        if (!target || !target.href) {
          log.push({ keyword: kw, result: "no-note" });
          continue;
        }
        const res = await openCardAndFollow(cdp, port, target.title);
        if (!res) {
          log.push({ keyword: kw, result: "open-failed" });
          continue;
        }
        const result = await postComment(res.cdp, comment);
        log.push({ keyword: kw, target: target.title, likes: target.likes, result });
        if (res.newTab) {
          try {
            await fetch(`http://127.0.0.1:${port}/json/close/${res.targetId}`);
          } catch {}
          res.cdp.close();
        }
        await sleep(rand(1500, 2500));
      }
    } else if (action === "scan") {
      // 截流扫描：找同行笔记，读评论区，分辨意向客户
      const city = (() => {
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--city") return args[i + 1] || "";
        }
        return "";
      })();
      for (const kw of keywords) {
        await search(cdp, kw);
        const cards = (await collectNotes(cdp, 30))
          .map((c) => ({ ...c, likes: parseCount(c.likeText) }))
          .sort((a, b) => b.likes - a.likes)
          .slice(0, top);
        const notes = [];
        for (const card of cards) {
          if (!card.href) continue;
          const res = await openCardAndFollow(cdp, port, card.title);
          if (!res) continue;
          await expandReplies(res.cdp);
          const comments = await collectComments(res.cdp);
          const leads = [];
          for (const c of comments) {
            const intent = classifyIntent(c.text);
            if (intent) {
              leads.push({ text: c.text, intent });
            }
          }
          const local = isLocalTitle(card.title, city);
          notes.push({
            title: card.title,
            likes: card.likes,
            local: local === null ? "unknown" : local,
            leads: leads.slice(0, 10),
            leadCount: leads.length
          });
          if (res.newTab) {
            try {
              await fetch(`http://127.0.0.1:${port}/json/close/${res.targetId}`);
            } catch {}
            res.cdp.close();
          } else {
            await ev(res.cdp, "history.back()").catch(() => {});
            await waitReady(res.cdp, 15_000);
          }
        }
        log.push({ keyword: kw, notes });
      }
    } else if (action === "reply") {
      // 评论区回复截留：给某条求地址/求推荐的评论种草式回复
      const keyword = keywords[0];
      const commentFragment = (() => {
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--to") return args[i + 1] || "";
        }
        return "";
      })();
      const titleMatch = (() => {
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--title") return args[i + 1] || "";
        }
        return "";
      })();
      if (!comment || !commentFragment) {
        console.error("reply 需要 --comment <回复话术> --to <目标评论片段>");
        process.exit(1);
      }
      const opened = await openNoteByTitle(cdp, port, keyword, titleMatch);
      if (!opened) {
        console.error(`未找到笔记: ${keyword} / ${titleMatch}`);
        process.exit(1);
      }
      const result = await replyComment(opened.cdp, commentFragment, comment);
      log.push({ keyword, to: commentFragment.slice(0, 30), reply: comment.slice(0, 40), result });
      if (opened.newTab) {
        try {
          await fetch(`http://127.0.0.1:${port}/json/close/${opened.targetId}`);
        } catch {}
        opened.cdp.close();
      }
    } else if (action === "reference") {
      // 爆改参考：收集爆款笔记（标题/点赞/评论区高频问题），供改写发布用
      for (const kw of keywords) {
        await search(cdp, kw);
        const cards = (await collectNotes(cdp, 30))
          .map((c) => ({ ...c, likes: parseCount(c.likeText) }))
          .sort((a, b) => b.likes - a.likes)
          .slice(0, top);
        const notes = [];
        for (const card of cards) {
          if (!card.href) continue;
          const res = await openCardAndFollow(cdp, port, card.title);
          if (!res) continue;
          const comments = await collectComments(res.cdp);
          notes.push({
            title: card.title,
            likes: card.likes,
            href: card.href,
            hotQuestions: comments.slice(0, 5).map((c) => c.text.slice(0, 40))
          });
          if (res.newTab) {
            try {
              await fetch(`http://127.0.0.1:${port}/json/close/${res.targetId}`);
            } catch {}
            res.cdp.close();
          } else {
            await ev(res.cdp, "history.back()").catch(() => {});
            await waitReady(res.cdp, 15_000);
          }
        }
        log.push({ keyword: kw, notes });
      }
    } else if (action === "inbox") {
      // 打开网页版消息页，读取会话/未读私信文本（供 agent 决策后回复）
      await ev(cdp, `location.href = 'https://www.xiaohongshu.com/chat?channel_type=message_pc_page'`);
      await waitReady(cdp, 25_000);
      await sleep(4000);
      const text = await ev(cdp, `(document.body.innerText || '').slice(0, 4000)`);
      log.push({ inbox: (text || "").slice(0, 2000) });
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
