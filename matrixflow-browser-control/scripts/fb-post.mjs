#!/usr/bin/env node
/**
 * Facebook 种草帖发布（2026-08-07 新增）
 *
 * 用法：
 *   node scripts/fb-post.mjs <profileSpec> --text-file D:\post.txt [--image D:\shot.png]
 *
 * 流程（一条 CDP 连接）：
 *   1. 确保在 facebook.com（未登录会自动停在登录页，需先人工登录）
 *   2. 点击首页发布框（分享你的新鲜事 / What's on your mind）
 *   3. 在内容区插入文案（execCommand insertText，换行自动成段落）
 *   4. 可选：--image 注入本地图片（DOM.setFileInputFiles，不弹文件框）
 *   5. 点击「发布 / Post」按钮
 *   6. 验证：发布框关闭且页面出现文案片段
 *
 * 注意：只支持已登录账号；发帖属于公开行为，请先确认文案合规。
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
        if (entry.name === profileId && existsSync(join(full, "DevToolsActivePort"))) {
          return full;
        }
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

async function waitReady(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await ev(cdp, "document.readyState")) === "complete") return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 2, y: y - 2 });
  await sleep(rand(60, 160));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(60, 140));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickElementByText(cdp, text, opts = {}) {
  const texts = Array.isArray(text) ? text : [text];
  const coords = await ev(
    cdp,
    `(() => {
      const targets = ${JSON.stringify(texts)};
      const candidates = [...document.querySelectorAll('div[role=button],button,span,div')]
        .filter(e => {
          const t = (e.textContent || '').trim();
          const aria = (e.getAttribute('aria-label') || '').trim();
          if (!targets.some(k => t === k || t.includes(k) || aria === k)) return false;
          const r = e.getBoundingClientRect();
          return r.width > 20 && r.height > 8 && r.width < 1200 && r.bottom > 0 && r.top < innerHeight;
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (ra.width * ra.height) - (rb.width * rb.height);
        });
      const el = candidates[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!coords) throw new Error(`找不到目标元素: ${texts.join('/')}`);
  const { x, y } = JSON.parse(coords);
  await clickAt(cdp, x + rand(-2, 2), y + rand(-2, 2));
  return { x, y };
}

async function setFileInput(cdp, filePath) {
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const q = await cdp.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: 'input[type=file][accept*="image"]',
  });
  if (!q.nodeId) throw new Error("找不到图片上传输入框 input[type=file]");
  await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [filePath] });
}

async function countAttachments(cdp) {
  return (
    (await ev(
      cdp,
      `[...document.querySelectorAll('img')].filter(i => i.naturalWidth > 50).length`
    )) || 0
  );
}

async function removeAllAttachments(cdp) {
  for (let round = 0; round < 8; round++) {
    const n = await countAttachments(cdp);
    if (n <= 0) return true;
    const btn = await ev(
      cdp,
      `(() => {
        const pick = [...document.querySelectorAll('div[role=button]')].find(e => {
          const a = (e.getAttribute('aria-label') || '');
          const r = e.getBoundingClientRect();
          return a.startsWith('移除') && r.bottom > 0 && r.top < innerHeight && r.width > 10;
        });
        if (pick) {
          const r = pick.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
        const editAll = [...document.querySelectorAll('div[role=button]')].find(e => {
          const a = (e.getAttribute('aria-label') || '');
          const r = e.getBoundingClientRect();
          return a === '全部编辑' && r.bottom > 0 && r.top < innerHeight && r.width > 10;
        });
        if (!editAll) return null;
        const r = editAll.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!btn) return false;
    const { x, y } = JSON.parse(btn);
    await clickAt(cdp, x, y);
    await sleep(1500);
  }
  return (await countAttachments(cdp)) <= 0;
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  if (!profileSpec) {
    console.error("用法: fb-post.mjs <profileSpec> --text-file <path> [--image <path>]");
    process.exit(1);
  }
  let textFile = "";
  let image = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--text-file") textFile = args[++i] || "";
    else if (args[i] === "--image") image = args[++i] || "";
  }
  if (!textFile || !existsSync(textFile)) {
    console.error("请提供存在的 --text-file 文案文件");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  if (image && !existsSync(image)) {
    console.error(`图片不存在: ${image}`);
    process.exit(1);
  }

  const profileDir = findProfileDir(profileSpec);
  if (!profileDir) throw new Error(`Profile ${profileSpec} is not running`);
  const port = Number.parseInt(
    readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0],
    10
  );
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page");
  const page =
    pages.find((t) => /facebook\.com/.test(t.url || "")) ||
    pages.find((t) => !/browser-start/.test(t.url || "")) ||
    pages[0];
  if (!page) throw new Error("No page target");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront").catch(() => {});
    const url = await ev(cdp, "location.href");
    if (!/facebook\.com/.test(url || "")) {
      await cdp.send("Page.navigate", { url: "https://www.facebook.com/" });
      await waitReady(cdp);
    }

    // 1) 打开发布框
    const started = Date.now();
    let composerFound = false;
    while (Date.now() - started < 20_000) {
      const opened = await ev(
        cdp,
        `document.querySelectorAll('div[contenteditable=true]').length > 0`
      );
      if (opened) { composerFound = true; break; }
      const clicked = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div,span')].find(e => {
            const t = (e.textContent || '').trim();
            if (!t.includes('分享你的新鲜事') && !t.includes('What\\'s on your mind')) return false;
            const r = e.getBoundingClientRect();
            return r.width > 100 && r.width < 900 && r.height > 20 && r.height < 200 && r.bottom > 0;
          });
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (clicked && clicked !== false) {
        const { x, y } = JSON.parse(clicked);
        await clickAt(cdp, x, y + rand(-5, 5));
      }
      await sleep(900);
    }
    if (!composerFound) throw new Error("发布框没有打开（可能未登录或页面结构变化）");
    await sleep(1200);

    // 1.5) 清理旧附件，避免内容冲突（重复图片会让发帖按钮失效）
    const beforeAttach = await countAttachments(cdp);
    if (beforeAttach > 0) {
      const cleaned = await removeAllAttachments(cdp);
      console.log(cleaned ? `[fb] 已清理 ${beforeAttach} 个旧附件` : "[fb] 附件清理未完成（尝试继续）");
      await sleep(800);
    }

    // 2) 输入文案（幂等：已存在则跳过；编辑区延迟出现时轮询等待）
    let typed = 0;
    for (let i = 0; i < 15; i++) {
      typed = await ev(
        cdp,
        `(() => {
          const els = [...document.querySelectorAll('div[contenteditable=true]')]
            .map(e => ({ e, r: e.getBoundingClientRect() }))
            .filter(o => o.r.width > 40 && o.r.height > 10)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
          const el = els[0] && els[0].e;
          if (!el) return 0;
          const probe = ${JSON.stringify(text.slice(0, 10))};
          if ((el.textContent || '').includes(probe)) return -1;
          el.focus();
          el.innerHTML = '';
          document.execCommand('insertText', false, ${JSON.stringify(text)});
          return el.textContent.length;
        })()`
      );
      if (typed !== 0) break;
      await sleep(800);
    }
    if (typed === 0) throw new Error("文案输入失败（找不到可见编辑区）");
    console.log(typed === -1 ? "[fb] 文案已在编辑框（跳过输入）" : `[fb] 文案已输入 ${typed} 字`);
    await sleep(rand(600, 1000));

    // 3) 可选：上传截图
    if (image) {
      await setFileInput(cdp, image);
      console.log("[fb] 图片已注入");
      await sleep(3000);
    }

    // 4) 等待图片上传完成（有照片预览且无进度条）
    if (image) {
      let ready = false;
      for (let i = 0; i < 20; i++) {
        const st = await ev(
          cdp,
          `(() => {
            const preview = [...document.querySelectorAll('img')].some(i => (i.alt || '').toLowerCase().includes(${JSON.stringify(
              String(image).split(/[\\/]/).pop().toLowerCase().replace(/\.[a-z0-9]+$/, '')
            )}));
            const busy = document.querySelectorAll('[role=progressbar]').length > 0;
            return JSON.stringify({ preview, busy });
          })()`
        );
        const s = JSON.parse(st);
        if (s.preview && !s.busy) { ready = true; break; }
        await sleep(1000);
      }
      console.log(ready ? "[fb] 图片上传完成" : "[fb] 图片上传状态未确认，继续尝试发布");
      await sleep(1000);
    }

    // 5) 点击发帖：只点“带照片的可见弹窗”里的按钮，点击前不滚动、坐标实时重算
    let posted = false;
    for (let i = 0; i < 8 && !posted; i++) {
      const coords = await ev(
        cdp,
        `(() => {
          const vis = o => { const r = o.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 30; };
          const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(d => vis(d) && d.getBoundingClientRect().width > 300);
          const pick = dialogs.filter(d => (d.innerText || '').includes('编辑影音内容') || (d.innerText || '').includes('mf-app'))
            .concat(dialogs);
          for (const d of pick) {
            const btn = [...d.querySelectorAll('div[role=button]')]
              .filter(b => {
                const t = (b.textContent || '').trim();
                const a = (b.getAttribute('aria-label') || '').trim();
                return (t === '发帖' || t === 'Post' || a === '发帖' || a === 'Post') && vis(b);
              })
              .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
            if (btn) {
              const r = btn.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }
          }
          return null;
        })()`
      );
      if (!coords) throw new Error("找不到可点的发帖按钮");
      const { x, y } = JSON.parse(coords);
      await clickAt(cdp, x + rand(-2, 2), y + rand(-2, 2));
      await sleep(4000);
      const check = await ev(
        cdp,
        `(() => {
          const ces = document.querySelectorAll('div[contenteditable=true]').length;
          const articles = [...document.querySelectorAll('[role=article]')].filter(a => (a.innerText || '').includes(${JSON.stringify(
            text.slice(0, 10)
          )})).length;
          return JSON.stringify({ ces, articles });
        })()`
      );
      const c = JSON.parse(check);
      if (c.ces === 0 || c.articles > 0) posted = true;
      else console.log(`[fb] 第 ${i + 1} 次点击未生效，重试`);
    }
    if (!posted) throw new Error("多次点击发布未生效，请人工检查页面");
    console.log("[fb] 已点击发布");

    // 5) 验证
    await sleep(5000);
    const probe = await ev(
      cdp,
      `(() => {
        const stillOpen = document.querySelectorAll('div[contenteditable=true]').length > 0;
        const fragment = ${JSON.stringify(text.split('\n')[0].slice(0, 12))};
        const feedHit = (document.body.innerText || '').includes(fragment);
        return JSON.stringify({ stillOpen, feedHit });
      })()`
    );
    console.log(`[fb] 验证: ${probe}  耗时 ${Math.round((Date.now() - started) / 1000)}s`);
    const p = JSON.parse(probe);
    console.log(p.stillOpen && !p.feedHit ? "[fb] 可能未发布成功，请人工检查页面" : "[fb] 发布成功");
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-post] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
