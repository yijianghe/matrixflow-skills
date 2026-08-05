#!/usr/bin/env node
/**
 * 小红书快速发布脚本（2026-08-05）
 *
 * 默认用平台原生「文字转图片」做封面，每次随机选不同模板；
 * 也支持本地图片（--image / --image-dir，默认从 Downloads / 桌面找）。
 * 全程一条 CDP 连接 + 轮询等待，速度优先。
 *
 * 用法：
 *   node scripts/xhs-publish.mjs <profileId> \
 *     --title "标题（≤20字）" --cover "封面文字" --body "正文（含话题）" \
 *     [--template random|基础|美漫|插图|涂鸦|清新|边框|备忘|简约|光影|手写] \
 *     [--visibility 仅自己可见|公开可见|仅互关好友可见] \
 *     [--image <文件路径> | --image-dir <文件夹>] \
 *     [--draft]        # 只存草稿不发布
 *
 * 说明：
 *   - 正文建议用 --body-file <path> 传入 UTF-8 文本文件（避免命令行引号问题）。
 *   - 本地图片默认目录：C:\Users\admin\Downloads、桌面、ShareX 截图目录。
 *   - 默认可见范围「仅自己可见」（私密），要公开请显式 --visibility 公开可见。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TITLES = ["基础", "美漫", "插图", "涂鸦", "涂写", "清新", "边框", "备忘", "简约", "光影", "手写"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(1, max - min));

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
  return { ws, send, close: () => { try { ws.close(); } catch {} } };
}

async function evalInPage(cdp, expression, timeout = 60000) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout });
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(rand(60, 140));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(30, 70));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function centerOf(cdp, expr) {
  return evalInPage(cdp, `(() => {
    const el = ${expr};
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
}

async function waitFor(cdp, expr, timeoutMs = 30000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evalInPage(cdp, expr);
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

function findLocalImage(imagePath, imageDir) {
  const candidates = [imagePath].filter(Boolean);
  if (imageDir) candidates.push(imageDir);
  const dirs = [join(homedir(), "Downloads"), join(homedir(), "Desktop"), join(homedir(), "Documents", "ShareX", "Screenshots")];
  for (const d of dirs) {
    if (existsSync(d)) candidates.push(d);
  }
  for (const c of candidates) {
    if (!c) continue;
    if (existsSync(c)) {
      if (c.toLowerCase().match(/\.(png|jpe?g|webp)$/)) return c;
      const files = readdirSync(c).filter((f) => f.toLowerCase().match(/\.(png|jpe?g|webp)$/));
      if (files.length) return join(c, files[0]);
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const profileId = args[0];
  if (!profileId) {
    console.error("Usage: xhs-publish.mjs <profileId> --title ... --cover ... --body ... [options]");
    process.exit(1);
  }
  const opt = { template: "random", visibility: "仅自己可见", draft: false };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--title") opt.title = args[++i];
    if (args[i] === "--cover") opt.cover = args[++i];
    if (args[i] === "--body") opt.body = args[++i];
    if (args[i] === "--body-file") opt.body = readFileSync(args[++i], "utf8").trim();
    if (args[i] === "--template") opt.template = args[++i];
    if (args[i] === "--visibility") opt.visibility = args[++i];
    if (args[i] === "--image") opt.image = args[++i];
    if (args[i] === "--image-dir") opt.imageDir = args[++i];
    if (args[i] === "--draft") opt.draft = true;
  }
  if (!opt.title || !opt.body) {
    console.error("Missing --title or --body/--body-file");
    process.exit(1);
  }
  if (opt.title.length > 20) {
    console.error(`标题 ${opt.title.length} 字 > 20，请缩短`);
    process.exit(1);
  }
  if (opt.template !== "random" && !TITLES.includes(opt.template)) {
    console.warn(`模板名"${opt.template}"不在已知列表，将尝试模糊匹配`);
  }
  if (opt.visibility === "公开可见" && !opt.draft) {
    console.error("公开发布需要显式确认：加 --draft 先看草稿，或确认后手动改脚本");
    process.exit(1);
  }

  const t0 = Date.now();
  const stamp = (label) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

  const profileDir = findProfileDir(String(profileId).split("@")[0]);
  if (!profileDir) throw new Error(`Profile ${profileId} not running`);
  const port = Number.parseInt(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official";

  // 确保发布页存在
  let targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = targets.find((t) => t.type === "page" && t.url.includes("creator.xiaohongshu.com/publish"));
  if (!page) {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = makeCdp(ver.webSocketDebuggerUrl);
    await bws.send("Target.createTarget", { url: PUBLISH_URL });
    bws.close();
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === "page" && t.url.includes("creator.xiaohongshu.com/publish"));
      if (page) break;
    }
  }
  if (!page) throw new Error("Cannot open publish page");
  stamp("发布页就绪");

  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 拦截系统文件选择对话框：即使误点"上传图片"也不会弹出 Windows 窗口
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});

  // 等待页面可交互（模式选择或表单）
  await waitFor(cdp, `!!(/上传图文|上传视频|input[placeholder*="标题"]/.test(document.body.innerText || '') || document.querySelector('input[placeholder*="标题"]'))`, 40000);
  await sleep(600);

  // 若停在「上传视频」模式 → 切「上传图文」（过滤隐藏副本）
  const mode = await evalInPage(cdp, `(() => {
    const t = document.body.innerText || '';
    if (!/拖拽视频到此|视频大小/.test(t) || document.querySelector('input[placeholder*="标题"]')) return 'ok';
    const leaf = [...document.querySelectorAll('*')].find((e) => {
      if (e.children.length !== 0 || (e.textContent || '').trim() !== '上传图文') return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight;
    });
    if (!leaf) return 'no-switch';
    const r = leaf.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (mode && mode.startsWith("{")) {
    const { x, y } = JSON.parse(mode);
    await clickAt(cdp, x, y);
    stamp("切换到上传图文");
    await sleep(1200);
  }

  if (opt.image || opt.imageDir) {
    // ---------- 本地图片模式 ----------
    const img = findLocalImage(opt.image, opt.imageDir);
    if (!img) throw new Error("No local image found (Downloads/Desktop/ShareX). Use --image <path> to specify.");
    console.log("IMAGE:", img);
    stamp("使用本地图片");
    const entry = await centerOf(cdp, `[...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '上传图片，或写文字生成图片')`);
    if (entry) await clickAt(cdp, entry.x, entry.y);
    await sleep(800);
    // 直接给隐藏 file input 注入文件（不弹对话框）
    const inputFound = await evalInPage(cdp, `!!document.querySelector('input[type="file"]')`);
    if (!inputFound) throw new Error("file input not found");
    const doc = await cdp.send("DOM.getDocument");
    const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
    await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [img] });
    stamp("图片已注入");
    await waitFor(cdp, `[...document.querySelectorAll('img')].some(i => i.getBoundingClientRect().width > 200)`, 30000);
    await sleep(1200);
  } else {
    // ---------- 文字转图片模式 ----------
    const entry = await centerOf(cdp, `[...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '上传图片，或写文字生成图片')`);
    if (!entry) throw new Error("entry not found");
    await clickAt(cdp, entry.x, entry.y);
    // 轮询等面板出现，点「文字配图」（绝不点「上传图片」）
    const textBtn = await waitFor(cdp, `(() => {
      const b = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '文字配图');
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`, 6000, 300);
    if (!textBtn) throw new Error("文字配图 button not found");
    const tb = JSON.parse(textBtn);
    await clickAt(cdp, tb.x, tb.y);
    await sleep(600);

    await evalInPage(cdp, `(() => {
      const ed = document.querySelector('.card-editor-container .ProseMirror');
      if (!ed) return 'no-editor';
      ed.focus();
      ed.innerHTML = '';
      document.execCommand('insertText', false, ${JSON.stringify(opt.cover || opt.title)});
      return ed.textContent;
    })()`);
    await sleep(400);
    const gen = await centerOf(cdp, `document.querySelector('.edit-text-button')`);
    if (!gen) throw new Error("generate button not found");
    await clickAt(cdp, gen.x, gen.y);
    stamp("已点生成图片（同文案走缓存会秒出）");

    const genStart = Date.now();
    let done = false;
    for (let i = 0; i < 180; i++) {
      await sleep(500);
      const st = await evalInPage(cdp, `(() => {
        const big = [...document.querySelectorAll('img')].some(x => x.getBoundingClientRect().width > 200);
        const btn = document.querySelector('.edit-text-button');
        return { big, btn: btn ? (btn.textContent || '').trim() : null };
      })()`);
      if (st && st.big && !st.btn) { done = true; break; }
      if (i > 60 && st && st.big) { done = true; break; }
    }
    if (!done) throw new Error("cover generation timeout");
    stamp(`封面生成完成（${((Date.now() - genStart) / 1000).toFixed(1)}s）`);
    await sleep(700);

    // 选模板：滚到底 → 随机/指定 → 点击后验证选中态（class/aria/预览图），失败重试
    const tplStart = Date.now();
    await evalInPage(cdp, `(() => {
      const first = document.querySelector('.cover-item-container');
      const sc = (() => {
        let cur = first;
        while (cur && cur !== document.body) {
          const s = getComputedStyle(cur);
          if (cur.scrollHeight > cur.clientHeight + 20 && (s.overflowY === 'auto' || s.overflowY === 'scroll')) return cur;
          cur = cur.parentElement;
        }
        return null;
      })();
      (sc || document.querySelector('[class*="cover-list"], [class*="template-list"]') || document.body).scrollTop = 1e6;
      return 'ok';
    })()`);
    await sleep(500);
    const tpl = await evalInPage(cdp, `(() => {
      const want = ${JSON.stringify(opt.template)};
      const items = [...document.querySelectorAll('.cover-item-container')].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight;
      });
      if (!items.length) return null;
      let target;
      if (want !== 'random') {
        target = items.find((c) => {
          const name = c.querySelector('.cover-name');
          return name && (name.textContent || '').trim() === want;
        });
      }
      if (!target) target = items[Math.floor(Math.random() * items.length)];
      const name = target.querySelector('.cover-name');
      const r = target.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), name: name ? (name.textContent || '').trim() : '', id: String(target.className || '').slice(0, 50) });
    })()`);
    if (!tpl) throw new Error("no template items found");
    const t = JSON.parse(tpl);
    const beforeSrc = await evalInPage(cdp, `(() => { const i = [...document.querySelectorAll('img')].find(x => x.getBoundingClientRect().width > 200); return i ? (i.currentSrc || i.src) : ''; })()`);
    let tplOk = false;
    for (let attempt = 0; attempt < 3 && !tplOk; attempt++) {
      await clickAt(cdp, t.x, t.y);
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        const chk = await evalInPage(cdp, `(() => {
          const items = [...document.querySelectorAll('.cover-item-container')];
          const active = items.filter((c) => /active|selected|checked/i.test(String(c.className || '')));
          if (active.length === 1) {
            const n = active[0].querySelector('.cover-name');
            return n ? (n.textContent || '').trim() : null;
          }
          const src = (() => { const img = [...document.querySelectorAll('img')].find((x) => x.getBoundingClientRect().width > 200); return img ? (img.currentSrc || img.src) : ''; })();
          return src && src !== ${JSON.stringify(beforeSrc)} ? '__src_changed' : null;
        })()`);
        if (chk === t.name || chk === "__src_changed") { tplOk = true; break; }
      }
    }
    stamp(`模板：${t.name}${tplOk ? "（已选中）" : "（未能验证，继续）"}，${((Date.now() - tplStart) / 1000).toFixed(1)}s`);
    await sleep(400);
  }

  // 下一步 → 表单
  const next = await centerOf(cdp, `[...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '下一步')`);
  if (!next) throw new Error("下一步 button not found");
  await clickAt(cdp, next.x, next.y);
  stamp("进入发布表单");
  await waitFor(cdp, `!!document.querySelector('input[placeholder*="标题"]')`, 20000);

  await evalInPage(cdp, `(() => {
    const el = document.querySelector('input[placeholder*="标题"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(opt.title)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await evalInPage(cdp, `(() => {
    const ed = document.querySelector('.tiptap.ProseMirror');
    if (!ed) return 'no-editor';
    ed.focus();
    ed.innerHTML = '';
    document.execCommand('insertText', false, ${JSON.stringify(opt.body)});
    return (ed.textContent || '').slice(0, 40);
  })()`);
  stamp("标题+正文已填");

  // 可见范围（轮询等选项出现 + 点后验证 + 重试一次）
  if (opt.visibility !== "公开可见") {
    const setVisibility = async () => {
      const perm = await centerOf(cdp, `document.querySelector('.permission-card-select')`);
      if (!perm) return false;
      await clickAt(cdp, perm.x, perm.y);
      const o = await waitFor(cdp, `(() => {
        const cands = [...document.querySelectorAll('.group-info .name, [class*="permission"] [class*="option"]')].filter(e => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(opt.visibility)});
        const vis = cands.find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight; });
        if (!vis) return null;
        vis.scrollIntoView({ block: 'center' });
        const r = vis.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`, 4000, 300);
      if (!o) return false;
      const { x, y } = JSON.parse(o);
      await clickAt(cdp, x, y);
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        const matched = await evalInPage(cdp, `(() => {
          const p = document.querySelector('.permission-card-select');
          const t = p ? (p.textContent || '').trim() : '';
          return t.includes(${JSON.stringify(opt.visibility)});
        })()`);
        if (matched) return true;
      }
      return false;
    };
    let ok = await setVisibility();
    if (!ok) ok = await setVisibility();
    stamp("可见范围：" + (ok ? opt.visibility : "设置失败！"));
  }

  // 发布 or 存草稿
  if (opt.draft) {
    const draftBtn = await evalInPage(cdp, `(() => {
      const cands = [
        ...document.querySelectorAll('button, [role="button"], xhs-draft-btn, [class*="draft"]')
      ].filter((x) => /草稿/.test((x.textContent || '').trim() + ' ' + (x.getAttribute('aria-label') || '')));
      const vis = cands.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight; });
      if (!vis) return null;
      vis.click();
      return 'clicked';
    })()`);
    stamp("已点存草稿：" + (draftBtn || "未找到草稿按钮（表单已保留，可直接人工存/发）"));
  } else {
    const pub = await evalInPage(cdp, `(() => {
      const host = document.querySelector('xhs-publish-btn');
      if (!host) return 'no-publish-host';
      const sr = host._sr || host.shadowRoot;
      if (!sr) return 'no-shadow';
      const b = sr.querySelector('button.bg-red');
      if (!b) return 'no-red-btn';
      b.click();
      return 'clicked';
    })()`);
    stamp("发布：" + pub);
    let published = false;
    for (let i = 0; i < 30; i++) {
      await sleep(800);
      const u = await evalInPage(cdp, "location.href");
      if (u && u.includes("published=true")) { published = true; break; }
    }
    stamp("发布结果：" + (published ? "成功" : "待确认"));
  }

  cdp.close();
  console.log(`TOTAL: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("[xhs-publish]", e.message);
  process.exit(1);
});
