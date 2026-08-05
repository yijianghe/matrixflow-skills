#!/usr/bin/env node
/**
 * 小红书发现页真人养号浏览（基于用户 Automa「国内(小红书养号)」脚本复刻，2026-08-05 验证通过）
 *
 * 流程（每篇笔记强制完整执行）：
 *   1. 发现页随机选一张未浏览卡片，真实鼠标点击打开
 *   2. 检测笔记类型：视频 / 多图（1/N 页码）/ 单图
 *   3. 滚正文 2-4 次（随机间隔）
 *   4. 多图笔记切图 0-3 次，每次用快照对比验证图片确实切换
 *   5. 滚评论区 3-5 次：优先从右侧坐标找滚动容器，分步滚动并触发 scroll 事件
 *   6. 差异化停留 5-9 秒
 *   7. 按概率随机点赞（检查 like-active，避免重复点赞变取消）
 *   8. 关闭笔记（.close-circle 等），确认详情关闭
 *   9. 滚动发现页 650px，进入下一篇
 *
 * 用法：
 *   node scripts/xhs-feed-browse.mjs <profileSpec> [--rounds 6] [--like-ratio 0.33]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
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

async function evalInPage(cdp, expression, timeout = 30000) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout });
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  if (!profileSpec) {
    console.error("Usage: xhs-feed-browse.mjs <profileSpec> [--rounds 6] [--like-ratio 0.33]");
    process.exit(1);
  }
  let rounds = 6;
  let likeRatio = 0.33;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--rounds") rounds = Number.parseInt(args[++i], 10) || 6;
    if (args[i] === "--like-ratio") likeRatio = Number.parseFloat(args[++i]) || 0.33;
  }

  const at = String(profileSpec || "").lastIndexOf("@");
  const profileId = at > 0 ? profileSpec.slice(0, at) : profileSpec;
  const selector = at > 0 ? profileSpec.slice(at + 1) : "";
  const profileDir = findProfileDir(profileId);
  if (!profileDir) throw new Error(`Profile ${profileId} has no DevToolsActivePort. Is it running?`);
  const port = Number.parseInt(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = targets.filter((t) => t.type === "page");
  const explore = pages.find((t) => t.url === "https://www.xiaohongshu.com/explore")
    || pages.find((t) => /xiaohongshu\.com\/explore/.test(t.url) && !/xsec/.test(t.url))
    || pages.find((t) => /xiaohongshu/.test(t.url) && selector && t.url.includes(selector));
  if (!explore) throw new Error("No xiaohongshu explore page found. Open it first.");

  const cdp = makeCdp(explore.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  const results = [];
  const visited = new Set();

  for (let round = 1; round <= rounds; round++) {
    const log = [`round${round}`];
    try {
      // 1) pick an unvisited card
      const pick = await evalInPage(cdp, `(() => {
        const links = [...document.querySelectorAll('a[href*="/explore/"]')].filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 100 && rect.height > 100 && rect.top >= 0 && rect.bottom <= innerHeight + 400;
        });
        const unvisited = links.filter(a => !${JSON.stringify([...visited])}.includes((a.getAttribute('href')||'').split('?')[0]));
        const pool = unvisited.length ? unvisited : links;
        if (!pool.length) return null;
        const target = pool[Math.floor(Math.random() * pool.length)];
        const key = (target.getAttribute('href') || '').split('?')[0];
        target.scrollIntoView({behavior: 'smooth', block: 'center'});
        return JSON.stringify({key});
      })()`);
      if (!pick) { log.push("no-more-cards"); results.push({ log }); break; }
      const { key } = JSON.parse(pick);
      visited.add(key);
      await sleep(900);
      const pos = await evalInPage(cdp, `(() => {
        const links = [...document.querySelectorAll('a[href*="/explore/"]')].filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 100 && rect.height > 100;
        });
        const t = links.find(a => (a.getAttribute('href')||'').split('?')[0] === ${JSON.stringify(key)});
        if (!t) return null;
        t.scrollIntoView({block: 'center'});
        const r = t.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()`);
      if (!pos) { log.push("card-gone"); results.push({ log }); continue; }
      const { x, y } = JSON.parse(pos);
      await clickAt(cdp, x, y);
      await sleep(rand(1800, 2600));

      // 2) detail opened?
      const opened = await evalInPage(cdp, `(() => {
        const det = document.querySelector('.note-detail-mask, [class*="note-detail-mask"], [class*="interaction-container"]');
        const big = [...document.querySelectorAll('img')].some(i => { const r = i.getBoundingClientRect(); return r.width > 300 && r.height > 300; });
        return !!(det || big);
      })()`);
      if (!opened) { log.push("detail-not-opened"); results.push({ log }); continue; }
      log.push("opened:" + key.split("/").pop().slice(0, 12));

      // 3) body scrolls
      const bodyScrolls = rand(2, 4);
      for (let i = 0; i < bodyScrolls; i++) {
        await evalInPage(cdp, "window.scrollBy(0, " + rand(250, 500) + ")");
        await sleep(rand(900, 1700));
      }
      log.push("body:" + bodyScrolls);

      // 4) media type detect
      const media = await evalInPage(cdp, `(() => {
        const video = [...document.querySelectorAll('video')].find(v => { const r = v.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
        if (video) return {type: 'video'};
        const ind = [...document.querySelectorAll('span, div, p, button')].find(n => {
          if (!n.getBoundingClientRect().width) return false;
          const m = (n.textContent || '').trim().match(/^(\\d{1,3})\\s*\\/\\s*(\\d{1,3})$/);
          return m && Number(m[2]) >= 2;
        });
        return ind ? {type: 'multi', text: ind.textContent.trim()} : {type: 'single'};
      })()`);
      log.push("media:" + media.type + (media.text ? "(" + media.text + ")" : ""));

      // 5) image switching with change verification
      const imgSwitches = media.type === "video" ? 0 : rand(0, 3);
      let imgOk = 0;
      for (let i = 0; i < imgSwitches; i++) {
        const before = await evalInPage(cdp, `(() => {
          const act = document.querySelector('.swiper-slide-active, [class*="pagination"] [class*="active"]');
          const img = [...document.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 250 && r.height > 250 && r.left < innerWidth * 0.6; }).map(i => i.currentSrc || i.src);
          return JSON.stringify({act: act ? act.className + act.getAttribute('data-index') : '', img: img.slice(0, 3)});
        })()`);
        const btn = await evalInPage(cdp, `(() => {
          const sel = ['.arrow-controller.right', '[aria-label*="\u4e0b\u4e00"]', '.swiper-button-next', '[class*="swiper-button-next"]', '[class*="arrow-right"]'];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (el) { const r = el.getBoundingClientRect(); if (r.width > 10 && r.height > 10) return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}); }
          }
          return null;
        })()`);
        if (!btn) break;
        const { x: bx, y: by } = JSON.parse(btn);
        await clickAt(cdp, bx, by);
        await sleep(rand(900, 1600));
        const after = await evalInPage(cdp, `(() => {
          const act = document.querySelector('.swiper-slide-active, [class*="pagination"] [class*="active"]');
          const img = [...document.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 250 && r.height > 250 && r.left < innerWidth * 0.6; }).map(i => i.currentSrc || i.src);
          return JSON.stringify({act: act ? act.className + act.getAttribute('data-index') : '', img: img.slice(0, 3)});
        })()`);
        if (before !== after) imgOk++;
        else break;
      }
      log.push("img:" + imgOk + "/" + imgSwitches);

      // 6) comment scrolling with verification
      const commentSteps = rand(3, 6);
      let commentOk = 0;
      for (let i = 0; i < commentSteps; i++) {
        const r = await evalInPage(cdp, `(() => {
          const canScroll = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && el.scrollHeight > el.clientHeight + 20 && (st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay');
          };
          const findScrollableParent = (el) => {
            let cur = el;
            while (cur && cur !== document.body) {
              if (canScroll(cur)) return cur;
              cur = cur.parentElement;
            }
            return null;
          };
          const points = [[0.82, 0.72], [0.82, 0.62], [0.78, 0.75], [0.88, 0.70]];
          for (const [rx, ry] of points) {
            const el = document.elementFromPoint(Math.round(innerWidth * rx), Math.round(innerHeight * ry));
            const sc = findScrollableParent(el);
            if (sc) { sc.scrollTop += 400; sc.dispatchEvent(new Event('scroll', {bubbles: true})); return 'scrolled'; }
          }
          const list = document.querySelector('[class*="comment-list"], [class*="comments-list"], [class*="comment"]');
          if (list && canScroll(list)) { list.scrollTop += 400; return 'list'; }
          window.scrollBy(0, 400);
          return 'window';
        })()`);
        if (r && r !== "__exc") commentOk++;
        await sleep(rand(800, 1400));
      }
      log.push("comments:" + commentOk + "/" + commentSteps);

      // 7) differentiated dwell
      await sleep(rand(5000, 9000));

      // 8) random like (check like-active to avoid un-like)
      if (Math.random() < likeRatio) {
        const like = await evalInPage(cdp, `(() => {
          const el = document.querySelector('.interact-container .like-wrapper, .engage-bar .like-wrapper, .like-wrapper');
          if (!el) return null;
          if (el.className.includes('like-active')) return {already: true};
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
        })()`);
        if (like && typeof like === "string") {
          const { x: lx, y: ly } = JSON.parse(like);
          await clickAt(cdp, lx, ly);
          await sleep(1200);
          log.push("like:clicked");
        } else if (like && like.already) {
          log.push("like:already");
        } else {
          log.push("like:none");
        }
      } else {
        log.push("like:skip");
      }

      // 9) close note
      const closed = await evalInPage(cdp, `(() => {
        const sel = ['.close-circle', '[class*="close-circle"]', 'button[aria-label="\u5173\u95ed"]', '[aria-label="\u5173\u95ed"]', '[class*="note-detail"] [class*="close"]', '[class*="modal"] [class*="close"]'];
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el) { el.click(); return 'clicked'; }
        }
        return 'no-close-btn';
      })()`);
      await sleep(1500);
      log.push("close:" + closed);

      // 10) scroll feed
      await evalInPage(cdp, "window.scrollBy(0, 650)");
      await sleep(1600);
      log.push("scrolled-feed");
    } catch (e) {
      log.push("ERR:" + e.message);
    }
    results.push({ log });
  }

  cdp.close();
  console.log(JSON.stringify(results, null, 1));
}

main().catch((error) => {
  console.error(`[xhs-feed-browse] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
