#!/usr/bin/env node
/**
 * Facebook 种草帖发布 v3（2026-08-07）
 *
 * 用法：
 *   node scripts/fb-post.mjs <profileSpec> --text-file D:\post.txt \
 *     [--image D:\a.png] [--image D:\b.png] ... [--video D:\v.mp4] [--visibility public]
 *
 * v3 要点（吸收实测教训）：
 *   - 单 CDP 会话完成全部步骤，避免多进程间状态抖动；
 *   - 逐行输入（Input.insertText + Enter），兼容 Facebook ProseMirror 编辑器；
 *   - 图片只注入一次；先清空旧附件，避免「无法与已添加的内容一起加入帖子」冲突；
 *   - 公开可见：打开隐私弹窗 → 点「公开」行 → 点「完成」；
 *   - 发帖只点“含文案弹窗”里的按钮（双弹窗叠层问题），合成事件 + 真实点击双保险；
 *   - 文案历史去重（fb-post-history.json）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
  await sleep(rand(60, 150));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(60, 140));
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
    console.error("用法: fb-post.mjs <profileSpec> --text-file <path> [--image ...] [--video ...] [--visibility public]");
    process.exit(1);
  }
  let textFile = "";
  const images = [];
  let video = "";
  let visibility = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--text-file") textFile = args[++i] || "";
    else if (args[i] === "--image") images.push(args[++i] || "");
    else if (args[i] === "--video") video = args[++i] || "";
    else if (args[i] === "--visibility") visibility = args[++i] || "";
  }
  if (!textFile || !existsSync(textFile)) {
    console.error("请提供存在的 --text-file");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const probe = text.slice(0, 8);
  const lines = text.split(/\r?\n/);
  const files = [...images, ...(video ? [video] : [])].filter((f) => f && existsSync(f));
  const hist = dedupCheck(text);

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
      await sleep(5000);
    }

    // 1) 打开发布框（无滚动点击）
    let composerOpen = false;
    for (let i = 0; i < 20 && !composerOpen; i++) {
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
      await sleep(1000);
    }
    if (!composerOpen) throw new Error("发布框没有打开");
    await sleep(1500);

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
      await sleep(1200);
    }

    // 3) 逐行输入文案
    const targetPos = await ev(
      cdp,
      `(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')]
          .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
        const target = dialogs.find(d => {
          const t = (d.innerText || '');
          const ce = d.querySelector('div[contenteditable=true]');
          return !t.includes(${JSON.stringify(probe)}) && ce && ce.getBoundingClientRect().width > 50;
        }) || dialogs.find(d => {
          const ce = d.querySelector('div[contenteditable=true]');
          return ce && ce.getBoundingClientRect().width > 50;
        });
        if (!target) return null;
        const ce = target.querySelector('div[contenteditable=true]');
        ce.focus();
        ce.innerHTML = '';
        const r = ce.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!targetPos) throw new Error("找不到编辑框");
    const tp = JSON.parse(targetPos);
    await clickAt(cdp, tp.x, tp.y);
    await sleep(400);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        await cdp.send("Input.insertText", { text: lines[i] });
        await sleep(rand(60, 180));
      }
      if (i < lines.length - 1) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await sleep(rand(60, 140));
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await sleep(rand(120, 260));
      }
    }
    await sleep(600);
    const typed = await ev(
      cdp,
      `(() => {
        const el = [...document.querySelectorAll('div[contenteditable=true]')].filter(e => e.getBoundingClientRect().width > 100)[0];
        return el ? (el.innerText || '').includes(${JSON.stringify(probe)}) : false;
      })()`
    );
    console.log(`[fb] 文案输入: ${typed ? "成功" : "未确认"}`);

    // 4) 关闭不含文案的空发布框（叠层的空壳，此时有文案的才是真框）
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
      await sleep(900);
    }

    // 5) 注入图片（只一次）
    if (files.length) {
      await setFiles(cdp, files);
      console.log(`[fb] 已注入 ${files.length} 个附件`);
      await sleep(6000);
    }

    // 6) 公开可见
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
        await sleep(1000);
        // 点「公开」行
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
          await sleep(900);
        }
        // 点「完成」
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
          await sleep(900);
        }
      }
      const after = await ev(
        cdp,
        `[...document.querySelectorAll('div[role=button]')].map(b => b.getAttribute('aria-label')||'').find(a => a.startsWith('编辑隐私设置')) || ''`
      );
      console.log(`[fb] 可见范围: ${after || "未知"}`);
    }

    // 7) 发帖：优先点「含文案弹窗」的按钮，合成事件 + 真实点击
    let posted = false;
    for (let attempt = 0; attempt < 6 && !posted; attempt++) {
      const btn = await ev(
        cdp,
        `(() => {
          const vis = o => { const r = o.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 30; };
          const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(d => vis(d) && d.getBoundingClientRect().width > 300);
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
              const fire = (type) => b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
              fire('pointerdown'); fire('mousedown'); b.focus(); fire('pointerup'); fire('mouseup'); fire('click');
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }
          }
          return null;
        })()`
      );
      if (!btn) {
        await sleep(2000);
        continue;
      }
      const b = JSON.parse(btn);
      await clickAt(cdp, b.x + rand(-2, 2), b.y + rand(-2, 2));
      await sleep(5000);
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
    console.log(`[fb] 发布成功，耗时 ${Math.round((Date.now() - started) / 1000)}s，已记录历史`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-post] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
