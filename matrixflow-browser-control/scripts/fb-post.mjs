#!/usr/bin/env node
/**
 * Facebook 种草帖发布 v4（2026-08-07）
 *
 * 用法：
 *   node scripts/fb-post.mjs <profileSpec> --text-file D:\post.txt \
 *     [--image D:\a.png] [--image D:\b.png] ... [--video D:\v.mp4] \
 *     [--visibility public] [--location "成都"] [--random-location]
 *
 * v4 关键修正（吸收实测反馈）：
 *   1. **先传图、后写文案**（之前先写文案再传图，Facebook 编辑器会把文案吞掉）；
 *   2. **发布前校验**：文案探针在编辑框 + 图片预览数达标，缺哪个补哪个；
 *   3. 提速：上传等待用轮询、减少固定 sleep；
 *   4. 可选随机定位（--random-location 或 --location "地点"）；
 *   5. 历史去重 + 公开可见 + 叠层空发布框清理（沿用 v3）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const RANDOM_LOCATIONS = ["成都", "上海", "北京", "深圳", "广州", "杭州", "重庆", "Sydney", "Melbourne", "Singapore", "Kuala Lumpur"];

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
  return { ws, send, close: () => { try { ws.close(); } catch {} } };
}

async function ev(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return null;
  return r.result?.value;
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 2, y: y - 2 });
  await sleep(rand(50, 120));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(50, 120));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function setFiles(cdp, files) {
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const q = await cdp.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: 'input[type=file][accept*="image"]',
  });
  if (!q.nodeId) throw new Error("找不到图片上传输入框");
  await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files });
}

async function countAttachments(cdp) {
  return (await ev(cdp, `[...document.querySelectorAll('img')].filter(i => i.naturalWidth > 50).length`)) || 0;
}

async function typeText(cdp, text) {
  // 真实点击聚焦 → execCommand insertText 整段插入（实测：带图后的标题框只吃 execCommand）
  const pos = await ev(
    cdp,
    `(() => {
      const els = [...document.querySelectorAll('div[contenteditable=true]')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(o => o.r.width > 100 && o.r.height > 20)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      const el = els[0] && els[0].e;
      if (!el) return null;
      el.focus();
      el.innerHTML = '';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!pos) return false;
  const p = JSON.parse(pos);
  await clickAt(cdp, p.x, p.y);
  await sleep(300);
  await ev(
    cdp,
    `(() => {
      const els = [...document.querySelectorAll('div[contenteditable=true]')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(o => o.r.width > 40)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      const el = els[0] && els[0].e;
      if (!el) return false;
      el.focus();
      el.innerHTML = '';
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return document.execCommand('insertText', false, ${JSON.stringify(text)});
    })()`
  );
  await sleep(400);
  return true;
}

async function setLocation(cdp, location) {
  // 点「签到」→ 搜索地点 → 选第一个结果
  const locBtn = await ev(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll('div[role=button]')].find(e => {
        const a = (e.getAttribute('aria-label') || '');
        const r = e.getBoundingClientRect();
        return (a === '签到' || a === 'Check in' || a === '位置') && r.bottom > 0 && r.top < innerHeight && r.width > 20;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!locBtn) return false;
  const b = JSON.parse(locBtn);
  await clickAt(cdp, b.x, b.y);
  await sleep(900);
  // 搜索框输入地点（用 input 事件，绝不回车提交，避免导航离开发布页）
  const typed = await ev(
    cdp,
    `(() => {
      const input = [...document.querySelectorAll('input')].find(i => {
        const ph = (i.getAttribute('placeholder') || '');
        const r = i.getBoundingClientRect();
        return (ph.includes('搜索') || ph.includes('地点') || ph.includes('位置')) && r.bottom > 0 && r.top < innerHeight && r.width > 100;
      });
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(location)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  if (!typed) return false;
  await sleep(1200);
  const option = await ev(
    cdp,
    `(() => {
      const items = [...document.querySelectorAll('div[role=button],li,[role=option]')].filter(e => {
        const t = (e.textContent || '').trim();
        const r = e.getBoundingClientRect();
        return t.includes(${JSON.stringify(location)}) && r.bottom > 0 && r.top < innerHeight && r.width > 80 && r.height > 20;
      }).sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      });
      const el = items[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!option) return false;
  const o = JSON.parse(option);
  await clickAt(cdp, o.x, o.y);
  await sleep(600);
  // 验证定位标签确实出现在发布框（防止误点成全局搜索导航）
  const chip = await ev(
    cdp,
    `(() => {
      const loc = [...document.querySelectorAll('div[role=button],span,div')].some(e => {
        const t = (e.textContent || '').trim();
        const r = e.getBoundingClientRect();
        return t === ${JSON.stringify(location)} && r.width > 20 && r.bottom > 0 && r.top < innerHeight;
      });
      const stillComposer = document.querySelectorAll('div[contenteditable=true]').length > 0;
      return JSON.stringify({ loc, stillComposer });
    })()`
  );
  const c = chip ? JSON.parse(chip) : { loc: false, stillComposer: false };
  if (!c.loc || !c.stillComposer) {
    // 没选上就撤销：按 Esc 关闭定位面板，不导航
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(500);
    return false;
  }
  return true;
}

function dedupCheck(text) {
  const histPath = join(resolveUserDataRoot(), "fb-post-history.json");
  const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf8") || "[]") : [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
  const grams = (s) => {
    const n = norm(s);
    const out = new Set();
    for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
    return out;
  };
  const mine = grams(text.slice(0, 100));
  for (const h of hist) {
    const theirs = grams(h.snippet || "");
    let common = 0;
    for (const g of mine) if (theirs.has(g)) common++;
    const sim = common / Math.max(1, Math.min(mine.size, theirs.size));
    if (sim > 0.55) throw new Error(`与历史帖相似度过高(${sim.toFixed(2)})，请换角度重写`);
  }
  return hist;
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  if (!profileSpec) {
    console.error("用法: fb-post.mjs <profileSpec> --text-file <path> [--image ...] [--video ...] [--visibility public] [--location 地点 | --random-location]");
    process.exit(1);
  }
  let textFile = "";
  const images = [];
  let video = "";
  let visibility = "";
  let location = "";
  let randomLocation = false;
  let noPost = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--text-file") textFile = args[++i] || "";
    else if (args[i] === "--image") images.push(args[++i] || "");
    else if (args[i] === "--video") video = args[++i] || "";
    else if (args[i] === "--visibility") visibility = args[++i] || "";
    else if (args[i] === "--location") location = args[++i] || "";
    else if (args[i] === "--random-location") randomLocation = true;
    else if (args[i] === "--no-post") noPost = true;
  }
  if (!textFile || !existsSync(textFile)) {
    console.error("请提供存在的 --text-file");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const probe = text.slice(0, 8);
  const files = [...images, ...(video ? [video] : [])].filter((f) => f && existsSync(f));
  const hist = dedupCheck(text);
  const finalLocation = randomLocation ? RANDOM_LOCATIONS[Math.floor(Math.random() * RANDOM_LOCATIONS.length)] : location;

  const dir = findProfileDir(profileSpec);
  if (!dir) throw new Error(`Profile ${profileSpec} is not running`);
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  if (!page) throw new Error("No facebook page");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  const started = Date.now();
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront").catch(() => {});
    const url = await ev(cdp, "location.href");
    if (!/facebook\.com/.test(url || "")) {
      await cdp.send("Page.navigate", { url: "https://www.facebook.com/" });
      await sleep(4000);
    }

    // 1) 打开发布框
    let composerOpen = false;
    for (let i = 0; i < 15 && !composerOpen; i++) {
      composerOpen = (await ev(cdp, `document.querySelectorAll('div[contenteditable=true]').length > 0`)) === true;
      if (composerOpen) break;
      const trig = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div[role=button]')].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return t.includes('分享你的新鲜事') && r.width > 100 && r.width < 900 && r.bottom > 0 && r.top < innerHeight;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (trig) {
        const t = JSON.parse(trig);
        await clickAt(cdp, t.x, t.y + rand(-4, 4));
      }
      await sleep(800);
    }
    if (!composerOpen) throw new Error("发布框没有打开");
    await sleep(1200);

    // 2) 清空旧附件（避免冲突）
    for (let i = 0; i < 8; i++) {
      const n = await countAttachments(cdp);
      if (n <= 0) break;
      const rm = await ev(
        cdp,
        `(() => {
          const btn = [...document.querySelectorAll('div[role=button]')].find(e => {
            const a = (e.getAttribute('aria-label') || '');
            const r = e.getBoundingClientRect();
            return a.startsWith('移除') && r.bottom > 0 && r.top < innerHeight && r.width > 10;
          });
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (!rm) break;
      const r = JSON.parse(rm);
      await clickAt(cdp, r.x, r.y);
      await sleep(1000);
    }

    // 3) 先传图/视频（重要：先图后文，避免编辑器吞文案）
    if (files.length) {
      await setFiles(cdp, files);
      console.log(`[fb] 已注入 ${files.length} 个附件，等待上传...`);
      let previews = 0;
      for (let i = 0; i < 30; i++) {
        previews = await countAttachments(cdp);
        if (previews >= files.length) break;
        await sleep(1000);
      }
      console.log(`[fb] 图片预览数: ${previews}/${files.length}`);
      await sleep(500);
    }

    // 4) 后写文案 + 校验
    let typedOk = false;
    for (let attempt = 0; attempt < 3 && !typedOk; attempt++) {
      await typeText(cdp, text);
      typedOk = (await ev(
        cdp,
        `(() => {
          const els = [...document.querySelectorAll('div[contenteditable=true]')];
          return els.some(e => (e.innerText || '').includes(${JSON.stringify(probe)}));
        })()`
      )) === true;
      if (!typedOk) console.log(`[fb] 文案校验未通过，第 ${attempt + 1} 次重输`);
    }
    if (!typedOk) throw new Error("文案输入失败（多次重试仍不出现）");
    console.log(`[fb] 文案已确认在编辑框`);

    // 5) 图文都在校验（缺图补图）
    const textThere = true;
    const needAttach = files.length;
    let imgCount = await countAttachments(cdp);
    if (needAttach && imgCount < needAttach) {
      console.log(`[fb] 图片不足(${imgCount}/${needAttach})，重新注入`);
      await setFiles(cdp, files);
      await sleep(3000);
      imgCount = await countAttachments(cdp);
    }
    console.log(`[fb] 发布前校验：文案=${textThere ? "有" : "无"} 图片=${imgCount}/${needAttach || "无"}`);
    if (needAttach && imgCount < 1) throw new Error("图片上传失败，终止发布");

    // 6) 关闭不含文案的空发布框（叠层）
    for (let i = 0; i < 4; i++) {
      const emptyClose = await ev(
        cdp,
        `(() => {
          const dialogs = [...document.querySelectorAll('[role=dialog]')]
            .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
          const empty = dialogs.find(o => {
            const t = (o.innerText || '');
            const ce = o.querySelector('div[contenteditable=true]');
            return !t.includes(${JSON.stringify(probe)}) && ce && ce.getBoundingClientRect().width > 50;
          });
          if (!empty) return null;
          const btn = [...empty.querySelectorAll('div[role=button]')].find(b => {
            const a = (b.getAttribute('aria-label') || '');
            const r = b.getBoundingClientRect();
            return a === '关闭编辑工具对话框' && r.bottom > 0 && r.top < innerHeight;
          });
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (!emptyClose) break;
      const c = JSON.parse(emptyClose);
      await clickAt(cdp, c.x, c.y);
      await sleep(800);
    }

    // 7) 定位（可选）
    if (finalLocation) {
      const okLoc = await setLocation(cdp, finalLocation);
      console.log(`[fb] 定位「${finalLocation}」: ${okLoc ? "成功" : "失败（跳过）"}`);
    }

    // 8) 公开可见
    if (visibility === "public") {
      const privBtn = await ev(
        cdp,
        `(() => {
          const dialogs = [...document.querySelectorAll('[role=dialog]')]
            .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
          const roots = dialogs.filter(d => (d.innerText || '').includes(${JSON.stringify(probe)}));
          const btn = (roots.length ? roots.map(r => [...r.querySelectorAll('div[role=button]')]).flat() : [...document.querySelectorAll('div[role=button]')])
            .find(e => {
              const a = (e.getAttribute('aria-label') || '');
              const r = e.getBoundingClientRect();
              return a.startsWith('编辑隐私设置') && r.bottom > 0 && r.top < innerHeight && r.width > 20;
            });
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (privBtn) {
        const p = JSON.parse(privBtn);
        await clickAt(cdp, p.x, p.y);
        await sleep(900);
        const pubRow = await ev(
          cdp,
          `(() => {
            const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText || '').includes('谁能看到你的帖子'));
            const scope = dlg || document;
            const el = [...scope.querySelectorAll('div')]
              .filter(e => {
                const t = (e.textContent || '').trim();
                const r = e.getBoundingClientRect();
                return t.startsWith('公开') && r.width > 300 && r.height > 50 && r.height < 200 && r.bottom > 0 && r.top < innerHeight;
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
        if (pubRow) {
          const u = JSON.parse(pubRow);
          await clickAt(cdp, u.x, u.y);
          await sleep(800);
        }
        const done = await ev(
          cdp,
          `(() => {
            const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText || '').includes('谁能看到你的帖子'));
            const scope = dlg || document;
            const el = [...scope.querySelectorAll('div[role=button]')].find(e => {
              const a = (e.getAttribute('aria-label') || '');
              const r = e.getBoundingClientRect();
              return a.startsWith('完成') && r.bottom > 0 && r.top < innerHeight && r.width > 30;
            });
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()`
        );
        if (done) {
          const d = JSON.parse(done);
          await clickAt(cdp, d.x, d.y);
          await sleep(800);
        }
      }
    }

    // 9) 发帖（合成事件 + 真实点击，只点含文案弹窗的按钮）
    if (noPost) {
      console.log(`[fb] 内容已全部就绪（--no-post 模式），跳过发布点击`);
      return;
    }
    let posted = false;
    for (let attempt = 0; attempt < 6 && !posted; attempt++) {
      const btn = await ev(
        cdp,
        `(() => {
          const vis = o => { const r = o.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 30; };
          const dialogs = [...document.querySelectorAll('[role=dialog]')]
            .filter(d => vis(d) && d.getBoundingClientRect().width > 300)
            .reverse(); // 最后渲染的在最上面，优先点
          const pick = dialogs.filter(d => (d.innerText || '').includes(${JSON.stringify(probe)}))
            .concat(dialogs.filter(d => (d.innerText || '').includes('添加更多内容')))
            .concat(dialogs);
          for (const d of pick) {
            const b = [...d.querySelectorAll('div[role=button]')]
              .filter(x => {
                const t = (x.textContent || '').trim();
                const a = (x.getAttribute('aria-label') || '').trim();
                return (t === '发帖' || t === 'Post' || a === '发帖' || a === 'Post') && vis(x) && x.getAttribute('aria-disabled') !== 'true';
              })
              .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
            if (b) {
              const r = b.getBoundingClientRect();
              const cx = r.x + r.width / 2;
              const cy = r.y + r.height / 2;
              if (cx < 0 || cy < 0 || cy > innerHeight) continue;
              // 坐标落点验证：排除被覆盖/隐藏副本
              const topEl = document.elementFromPoint(cx, cy);
              const hit = topEl === b || b.contains(topEl) || (topEl && topEl.closest && b.contains(topEl.closest('div[role=button]')));
              if (!hit) continue;
              if (attempt === 0) {
                // 首选：原生 el.click()（实测能触发 React 发布）
                b.click();
                return JSON.stringify({ x: cx, y: cy, native: true });
              }
              // 兜底：真实鼠标点击
              return JSON.stringify({ x: cx, y: cy, native: false });
            }
          }
          return null;
        })()`
      );
      if (!btn) { await sleep(1500); continue; }
      const b = JSON.parse(btn);
      if (!b.native) await clickAt(cdp, b.x + rand(-2, 2), b.y + rand(-2, 2));
      await sleep(4000);
      const check = await ev(
        cdp,
        `(() => {
          const ces = document.querySelectorAll('div[contenteditable=true]').length;
          const arts = [...document.querySelectorAll('[role=article]')].filter(a => (a.innerText || '').includes(${JSON.stringify(probe)})).length;
          return JSON.stringify({ ces, arts });
        })()`
      );
      const c = JSON.parse(check);
      if (c.ces === 0 || c.arts > 0) posted = true;
      else console.log(`[fb] 第 ${attempt + 1} 次点击未生效，重试`);
    }
    if (!posted) throw new Error("多次点击发布未生效");

    hist.push({ at: new Date().toISOString(), snippet: text.slice(0, 100) });
    writeFileSync(join(resolveUserDataRoot(), "fb-post-history.json"), JSON.stringify(hist, null, 2), "utf8");
    console.log(`[fb] 发布成功（定位：${finalLocation || "无"}），耗时 ${Math.round((Date.now() - started) / 1000)}s，已记录历史`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-post] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
