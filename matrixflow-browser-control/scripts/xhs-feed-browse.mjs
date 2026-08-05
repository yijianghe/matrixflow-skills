#!/usr/bin/env node
/**
 * 小红书发现页真人养号浏览 v2（2026-08-05）
 *
 * 相比 v1 的关键修复：
 *   1. 详情页打开后【只滚动右侧内容面板 .note-scroller】，绝不滚动 window/背景瀑布流
 *      （v1 在详情页里 window.scrollBy 导致"打开笔记后背景还在滚"）
 *   2. 图文笔记停留 30-45 秒（可调 --min-dwell），视频按播放进度等待
 *   3. 点赞/收藏是【概率行为】（默认赞 35%、藏 20%），先查 like-active/collect-active
 *      状态，已互动不再重复点；用数字 +1 验证成功，数字 -1 自动恢复
 *   4. 点开二级/三级评论：随机点 1-3 个"展开 N 条回复"(.show-more)，展开后再点嵌套的
 *      "查看回复/条回复"，用 .note-scroller.scrollHeight 增长验证
 *   5. 多图笔记切图 1-3 次，每次用轮播快照对比验证确实切换
 *   6. 所有动作次数、间隔、停留时长全部随机差异化
 *
 * 用法：
 *   node scripts/xhs-feed-browse.mjs <profileId> [--rounds 6] [--like-ratio 0.35]
 *       [--collect-ratio 0.2] [--max-likes 30] [--max-collects 20] [--min-dwell 30]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const rand = (min, max) => Math.floor(min + Math.random() * Math.max(1, max - min));
const chance = (p) => Math.random() < p;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveUserDataRoot() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "@matrixflow", "desktop");
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

async function evalInPage(cdp, expression, timeout = 45000) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout,
  });
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(rand(120, 280));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(40, 100));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// 页面内工具函数（一次注入，后续所有步骤复用）
const HELPERS = `
window.__mf = {
  isVisible(el) {
    if (!el || !document.contains(el)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
      r.right > 0 && r.left < innerWidth && s.display !== "none" &&
      s.visibility !== "hidden" && Number(s.opacity || 1) > 0;
  },
  isDetailOpen() {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return false;
    const r = dm.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  getScrollContainer() {
    const sc = document.querySelector(".note-scroller");
    if (sc && sc.scrollHeight > sc.clientHeight + 20) return sc;
    const points = [[0.82, 0.72], [0.82, 0.62], [0.78, 0.75], [0.88, 0.70]];
    for (const [rx, ry] of points) {
      const el = document.elementFromPoint(Math.round(innerWidth * rx), Math.round(innerHeight * ry));
      let cur = el;
      while (cur && cur !== document.body) {
        const s = getComputedStyle(cur);
        if (cur.scrollHeight > cur.clientHeight + 20 &&
            (s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowY === "overlay") &&
            cur.getBoundingClientRect().width > 0) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  },
  scrollDetail(delta) {
    if (!this.isDetailOpen()) return { ok: false, why: "detail-closed" };
    const sc = this.getScrollContainer();
    if (!sc) return { ok: false, why: "no-container" };
    const maxScroll = sc.scrollHeight - sc.clientHeight;
    if (maxScroll <= 0) return { ok: true, status: "short", after: 0 };
    if (sc.scrollTop >= maxScroll - 8) return { ok: true, status: "bottom", after: sc.scrollTop };
    const before = sc.scrollTop;
    sc.scrollTop += delta;
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    if (sc.scrollTop > before) return { ok: true, status: "scrolled", before, after: sc.scrollTop, container: String(sc.className || "").slice(0, 40) };
    const r = sc.getBoundingClientRect();
    sc.dispatchEvent(new WheelEvent("wheel", {
      deltaY: delta,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return { ok: sc.scrollTop > before, status: sc.scrollTop > before ? "wheeled" : "stuck", before, after: sc.scrollTop, container: String(sc.className || "").slice(0, 40) };
  },
  mediaInfo() {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return null;
    const video = [...dm.querySelectorAll("video")].find((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 200 && r.height > 200;
    });
    if (video) return { type: "video", duration: isFinite(video.duration) ? video.duration : 0, paused: video.paused, currentTime: video.currentTime };
    const inds = [...dm.querySelectorAll("span, div, p")].filter((n) => {
      if (!this.isVisible(n)) return false;
      const r = n.getBoundingClientRect();
      if (r.width >= 180 || r.width <= 0) return false;
      return /^\\d{1,3}\\s*\\/\\s*\\d{1,3}$/.test((n.textContent || "").trim());
    });
    if (inds.length) {
      const m = (inds[0].textContent || "").trim().match(/^(\\d{1,3})\\s*\\/\\s*(\\d{1,3})$/);
      return { type: "multi", current: Number(m[1]), total: Number(m[2]) };
    }
    const arrow = dm.querySelector(".arrow-controller.right, [class*='arrow-right'], [class*='swiper-button-next']");
    if (arrow && arrow.getBoundingClientRect().width > 10) return { type: "multi", current: 0, total: 0, arrow: true };
    return { type: "single" };
  },
  carouselSnapshot() {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return "";
    const act = [];
    for (const sel of [".swiper-slide-active", ".swiper-pagination-bullet-active", "[class*='pagination'] [class*='active']", "[aria-current='true']"]) {
      dm.querySelectorAll(sel).forEach((el) => {
        if (this.isVisible(el)) act.push([el.tagName, String(el.className || ""), el.getAttribute("data-index"), el.getAttribute("style")].filter(Boolean).join("|"));
      });
    }
    const imgs = [...dm.querySelectorAll("img")].filter((i) => {
      const r = i.getBoundingClientRect();
      return this.isVisible(i) && r.width > 250 && r.height > 250 && r.left < innerWidth * 0.6;
    }).map((i) => (i.currentSrc || i.src) + "|" + Math.round(i.getBoundingClientRect().left));
    const tr = [...dm.querySelectorAll("[class*='swiper-wrapper'], [class*='slider'], [class*='carousel']")]
      .filter((e) => this.isVisible(e))
      .map((e) => String(e.className || "") + "|" + getComputedStyle(e).transform);
    return JSON.stringify({ act, imgs, tr });
  },
  findNextImageButton() {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return null;
    const sels = ["div.arrow-controller.right", ".arrow-controller.right", "[aria-label*='下一']", "button[aria-label*='next' i]", ".swiper-button-next", "[class*='swiper-button-next']", "[class*='arrow-right']"];
    for (const s of sels) {
      const el = dm.querySelector(s);
      if (el && this.isVisible(el)) {
        const target = el.querySelector(".btn-wrapper") || el;
        const r = target.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  },
  getExpandButtons() {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return [];
    const sc = this.getScrollContainer();
    const vp = sc ? sc.getBoundingClientRect() : null;
    const out = [];
    for (const el of dm.querySelectorAll(".show-more, [class*='show-more'], [class*='view-replies'], [class*='reply'] [class*='more']")) {
      if (!this.isVisible(el)) continue;
      const txt = (el.textContent || "").trim();
      if (!/回复|展开|查看/.test(txt)) continue;
      const r = el.getBoundingClientRect();
      if (vp && (r.top < vp.top - 60 || r.bottom > vp.bottom + 60)) continue;
      out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: txt.slice(0, 24) });
    }
    return out;
  },
  getActionButton(kind) {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return null;
    const bar = dm.querySelector(".engage-bar, .interact-container, .buttons.engage-bar-style");
    const root = bar || dm;
    const el = root.querySelector(kind === "like" ? ".like-wrapper" : ".collect-wrapper, .star-wrapper");
    if (!el) return null;
    const active = String(el.className || "").toLowerCase().includes("active");
    const txt = (el.textContent || "").trim().replace(/[^\\d]/g, "");
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      active,
      count: txt ? Number(txt) : 0,
      cls: String(el.className || "").slice(0, 50),
    };
  },
  closeDetailButton() {
    const dm = document.querySelector(".note-detail-mask");
    if (!dm) return null;
    const el = dm.querySelector(".close-circle") ||
      [...dm.querySelectorAll("[class*='close']")].find((e) => {
        const r = e.getBoundingClientRect();
        return this.isVisible(e) && r.width >= 18 && r.width <= 90 && r.height >= 18 && r.height <= 90;
      });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  },
  pickFeedCard(visitedKeys) {
    const links = [...document.querySelectorAll('a[href*="/explore/"]')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 100 && r.height > 100 && r.bottom > 0 && r.top < innerHeight + 300;
    });
    const unvisited = links.filter((a) => !visitedKeys.includes((a.getAttribute("href") || "").split("?")[0]));
    const pool = unvisited.length ? unvisited : links;
    if (!pool.length) return null;
    const t = pool[Math.floor(Math.random() * pool.length)];
    const key = (t.getAttribute("href") || "").split("?")[0];
    t.scrollIntoView({ behavior: "smooth", block: "center" });
    return key;
  },
  cardCenter(key) {
    const links = [...document.querySelectorAll('a[href*="/explore/"]')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    });
    const t = links.find((a) => (a.getAttribute("href") || "").split("?")[0] === key);
    if (!t) return null;
    t.scrollIntoView({ block: "center" });
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  },
  scrollerHeight() {
    const s = document.querySelector(".note-scroller");
    return s ? s.scrollHeight : 0;
  },
  videoProgress() {
    const v = [...document.querySelectorAll(".note-detail-mask video")].find((x) => x.getBoundingClientRect().width > 200);
    return v ? { t: v.currentTime, d: isFinite(v.duration) ? v.duration : 0, p: v.paused } : null;
  },
};
`;

async function ensureExplorePage(port) {
  const list = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  let targets = await list();
  let page = targets.find((t) => t.type === "page" && t.url === "https://www.xiaohongshu.com/explore")
    || targets.find((t) => t.type === "page" && /xiaohongshu\.com\/explore/.test(t.url) && !t.url.includes("search_result"));
  if (page) return page;
  // 已有小红书页面 → 直接导航到发现页
  const xhs = targets.find((t) => t.type === "page" && /xiaohongshu\.com/.test(t.url));
  if (xhs) {
    const c = makeCdp(xhs.webSocketDebuggerUrl);
    await c.send("Page.enable");
    await c.send("Page.navigate", { url: "https://www.xiaohongshu.com/explore" });
    c.close();
  } else {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = makeCdp(ver.webSocketDebuggerUrl);
    await bws.send("Target.createTarget", { url: "https://www.xiaohongshu.com/explore" });
    bws.close();
  }
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    targets = await list();
    page = targets.find((t) => t.type === "page" && /xiaohongshu\.com\/explore/.test(t.url) && !t.url.includes("search_result"));
    if (page) return page;
  }
  return null;
}

async function waitActionState(cdp, kind, before, activeBefore) {
  // 点击后轮询：active 变 true = 成功；数字 -1 = 误取消，自动恢复
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const b = await evalInPage(cdp, `window.__mf.getActionButton(${JSON.stringify(kind)})`);
    if (!b) continue;
    if (b.active && !activeBefore) return "ok";
    if (b.count > before) return "ok";
    if (b.count < before) {
      await clickAt(cdp, b.x, b.y);
      await sleep(900);
      const b2 = await evalInPage(cdp, `window.__mf.getActionButton(${JSON.stringify(kind)})`);
      return b2 && b2.active ? "ok" : "restored";
    }
  }
  return "nochange";
}

async function closeDetail(cdp) {
  const btn = await evalInPage(cdp, "window.__mf.closeDetailButton()");
  if (!btn) return "no-btn";
  await clickAt(cdp, btn.x, btn.y);
  for (let i = 0; i < 12; i++) {
    await sleep(350);
    const open = await evalInPage(cdp, "window.__mf.isDetailOpen()");
    if (!open) return "closed";
  }
  const btn2 = await evalInPage(cdp, "window.__mf.closeDetailButton()");
  if (btn2) {
    await clickAt(cdp, btn2.x, btn2.y);
    await sleep(1200);
    return (await evalInPage(cdp, "window.__mf.isDetailOpen()")) ? "failed" : "closed-retry";
  }
  return "failed";
}

async function processOne(cdp, ctx) {
  const log = [];
  const t0 = Date.now();

  const key = await evalInPage(cdp, `window.__mf.pickFeedCard(${JSON.stringify([...ctx.visited])})`);
  if (!key) return { log: [...log, "no-more-cards"], stop: true };
  ctx.visited.add(key);
  await sleep(rand(900, 1600));
  const pos = await evalInPage(cdp, `window.__mf.cardCenter(${JSON.stringify(key)})`);
  if (!pos) return { log: [...log, "card-gone"] };
  await clickAt(cdp, pos.x, pos.y);
  log.push("opened:" + key.split("/").pop().slice(0, 12));

  let opened = false;
  for (let i = 0; i < 24; i++) {
    opened = await evalInPage(cdp, "window.__mf.isDetailOpen()");
    if (opened) break;
    await sleep(350);
  }
  if (!opened) return { log: [...log, "detail-not-opened"] };

  const media = await evalInPage(cdp, "window.__mf.mediaInfo()");
  log.push("type:" + (media ? media.type + (media.type === "multi" && media.total ? `(${media.current}/${media.total})` : "") : "unknown"));

  // 滚正文：只滚 .note-scroller，绝不滚 window
  const bodySteps = media && media.type === "video" ? rand(2, 3) : rand(2, 5);
  let bodyOk = 0;
  for (let i = 0; i < bodySteps; i++) {
    if (!(await evalInPage(cdp, "window.__mf.isDetailOpen()"))) { log.push("detail-lost"); break; }
    const r = await evalInPage(cdp, `window.__mf.scrollDetail(${rand(180, 420)})`);
    if (r && r.ok) bodyOk++;
    if (r && (r.status === "bottom" || r.status === "short")) break;
    await sleep(rand(900, 2400));
  }
  log.push("body:" + bodyOk + "/" + bodySteps);

  // 多图切图（快照验证）
  let imgOk = 0;
  if (media && (media.type === "multi")) {
    const maxSwitch = Math.min(3, Math.max(1, (media.total || 4) - (media.current || 1)));
    const switches = rand(1, maxSwitch + 1);
    for (let i = 0; i < switches; i++) {
      const before = await evalInPage(cdp, "window.__mf.carouselSnapshot()");
      const btn = await evalInPage(cdp, "window.__mf.findNextImageButton()");
      if (!btn) break;
      await clickAt(cdp, btn.x, btn.y);
      let changed = false;
      for (let k = 0; k < 10; k++) {
        await sleep(500);
        const after = await evalInPage(cdp, "window.__mf.carouselSnapshot()");
        if (after && after !== before) { changed = true; break; }
      }
      if (changed) imgOk++;
      else break;
      await sleep(rand(900, 1900));
    }
  }
  log.push("img:" + imgOk);

  // 视频：按播放进度等待
  if (media && media.type === "video") {
    const v = await evalInPage(cdp, "window.__mf.videoProgress()");
    if (v) {
      const target = v.d > 0 ? Math.min(v.d * 0.7, 40) : rand(18, 30);
      const deadline = Date.now() + Math.max(12000, Math.round(target * 1000));
      let progressed = false;
      while (Date.now() < deadline) {
        await sleep(2500);
        const v2 = await evalInPage(cdp, "window.__mf.videoProgress()");
        if (v2 && v2.t > v.t + 2) { progressed = true; break; }
      }
      log.push("video:" + (progressed ? "played" : "waited"));
      if (!progressed) await sleep(rand(5000, 9000));
    }
  }

  // 滚评论区（仍在 .note-scroller 内）
  const commentSteps = rand(3, 6);
  let commentOk = 0;
  for (let i = 0; i < commentSteps; i++) {
    if (!(await evalInPage(cdp, "window.__mf.isDetailOpen()"))) { log.push("detail-lost"); break; }
    const r = await evalInPage(cdp, `window.__mf.scrollDetail(${rand(260, 540)})`);
    if (r && r.ok) commentOk++;
    if (r && (r.status === "bottom" || r.status === "short")) break;
    await sleep(rand(1000, 2600));
  }
  log.push("comments:" + commentOk + "/" + commentSteps);

  // 点开二级/三级评论
  const expandMax = rand(1, 3);
  let expanded = 0;
  for (let i = 0; i < expandMax; i++) {
    const btns = await evalInPage(cdp, "window.__mf.getExpandButtons()");
    if (!btns || !btns.length) break;
    const b = btns[Math.floor(Math.random() * btns.length)];
    const beforeH = await evalInPage(cdp, "window.__mf.scrollerHeight()");
    await clickAt(cdp, b.x, b.y);
    let grew = false;
    for (let k = 0; k < 8; k++) {
      await sleep(600);
      const afterH = await evalInPage(cdp, "window.__mf.scrollerHeight()");
      if (afterH > beforeH + 50) { grew = true; break; }
    }
    if (grew) { expanded++; await sleep(rand(900, 1900)); }
    else break;
  }
  log.push("expand:" + expanded);

  // 概率互动：点赞 35% / 收藏 20%（带状态检查 + 计数上限）
  let likeAct = "skip";
  let collectAct = "skip";
  if (chance(ctx.likeRatio) && ctx.likes < ctx.maxLikes) {
    const b = await evalInPage(cdp, "window.__mf.getActionButton('like')");
    if (b && !b.active) {
      const before = b.count;
      await clickAt(cdp, b.x, b.y);
      const r = await waitActionState(cdp, "like", before, false);
      if (r === "ok") { ctx.likes++; likeAct = "liked"; }
      else likeAct = r;
    } else if (b && b.active) likeAct = "already";
    else likeAct = "none";
  }
  if (chance(ctx.collectRatio) && ctx.collects < ctx.maxCollects) {
    const b = await evalInPage(cdp, "window.__mf.getActionButton('collect')");
    if (b && !b.active) {
      const before = b.count;
      await clickAt(cdp, b.x, b.y);
      const r = await waitActionState(cdp, "collect", before, false);
      if (r === "ok") { ctx.collects++; collectAct = "collected"; }
      else collectAct = r;
    } else if (b && b.active) collectAct = "already";
    else collectAct = "none";
  }
  log.push("like:" + likeAct + "/" + ctx.likes + " collect:" + collectAct + "/" + ctx.collects);

  // 保证图文停留 ≥ 30 秒（随机补足 30-45 秒区间）
  const elapsed = Date.now() - t0;
  const minMs = ctx.minDwell * 1000;
  if (elapsed < minMs) {
    await sleep(rand(minMs - elapsed, minMs - elapsed + 9000));
  }
  log.push("dwell:" + Math.round((Date.now() - t0) / 1000) + "s");

  // 关闭详情 → 确认关闭 → 滚发现页
  const closed = await closeDetail(cdp);
  log.push("close:" + closed);
  await sleep(rand(800, 1500));
  await evalInPage(cdp, `window.scrollBy({top: ${rand(500, 800)}, behavior: "smooth"})`);
  await sleep(rand(1200, 2200));
  log.push("feed-scrolled");
  return { log };
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  if (!profileSpec) {
    console.error("Usage: xhs-feed-browse.mjs <profileId> [--rounds 6] [--like-ratio 0.35] [--collect-ratio 0.2] [--max-likes 30] [--max-collects 20] [--min-dwell 30]");
    process.exit(1);
  }
  let rounds = 6;
  let likeRatio = 0.35;
  let collectRatio = 0.2;
  let maxLikes = 30;
  let maxCollects = 20;
  let minDwell = 30;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--rounds") rounds = Number.parseInt(args[++i], 10) || 6;
    if (args[i] === "--like-ratio") likeRatio = Number.parseFloat(args[++i]);
    if (args[i] === "--collect-ratio") collectRatio = Number.parseFloat(args[++i]);
    if (args[i] === "--max-likes") maxLikes = Number.parseInt(args[++i], 10) || 30;
    if (args[i] === "--max-collects") maxCollects = Number.parseInt(args[++i], 10) || 20;
    if (args[i] === "--min-dwell") minDwell = Number.parseInt(args[++i], 10) || 30;
  }

  const profileId = String(profileSpec).split("@")[0];
  const profileDir = findProfileDir(profileId);
  if (!profileDir) throw new Error(`Profile ${profileId} has no DevToolsActivePort. Is it running?`);
  const port = Number.parseInt(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);

  const explore = await ensureExplorePage(port);
  if (!explore) throw new Error("Cannot open xiaohongshu explore page");

  const cdp = makeCdp(explore.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const init = await evalInPage(cdp, HELPERS + " 'ok'");
  if (!init || init === undefined) throw new Error("Helper injection failed: " + JSON.stringify(init));

  // 若上次遗留打开的详情，先关掉
  if (await evalInPage(cdp, "window.__mf.isDetailOpen()")) {
    const b = await evalInPage(cdp, "window.__mf.closeDetailButton()");
    if (b) { await clickAt(cdp, b.x, b.y); await sleep(1200); }
  }

  const ctx = {
    visited: new Set(),
    likes: 0,
    collects: 0,
    likeRatio,
    collectRatio,
    maxLikes,
    maxCollects,
    minDwell,
  };
  const results = [];
  for (let round = 1; round <= rounds; round++) {
    const res = await processOne(cdp, ctx);
    results.push({ round, ...res });
    if (res.stop) break;
  }
  cdp.close();
  console.log(JSON.stringify(results, null, 1));
}

main().catch((error) => {
  console.error(`[xhs-feed-browse] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
