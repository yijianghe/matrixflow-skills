#!/usr/bin/env node
/**
 * Facebook 群组发帖（2026-08-07 新增）
 * 搜索相关小组 → 进入 → 在群内发种草帖（先图后文 + 校验）。
 *
 * 用法:
 *   node scripts/fb-group-post.mjs <profileId> --keyword "digital marketing" \
 *     --text-file D:\post.txt [--image D:\a.png] [--image D:\b.png]
 *   或指定群组: --group https://www.facebook.com/groups/xxxx
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

async function main() {
  const args = process.argv.slice(2);
  const profileId = args[0];
  if (!profileId) {
    console.error("用法: fb-group-post.mjs <profileId> --keyword <关键词> | --group <url> --text-file <path> [--image ...]");
    process.exit(1);
  }
  let keyword = "";
  let groupUrl = "";
  let textFile = "";
  const images = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--keyword") keyword = args[++i] || "";
    else if (args[i] === "--group") groupUrl = args[++i] || "";
    else if (args[i] === "--text-file") textFile = args[++i] || "";
    else if (args[i] === "--image") images.push(args[++i] || "");
  }
  if (!groupUrl && !keyword) {
    console.error("请提供 --group <url> 或 --keyword <关键词>");
    process.exit(1);
  }
  if (!textFile || !existsSync(textFile)) {
    console.error("请提供存在的 --text-file");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const probe = text.slice(0, 8);
  const files = images.filter((f) => f && existsSync(f));

  const dir = findProfileDir(profileId);
  if (!dir) throw new Error(`Profile ${profileId} is not running`);
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
  if (!page) throw new Error("No page target");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  const started = Date.now();
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront").catch(() => {});

    // 1) 进入群组（搜索或直达）
    if (groupUrl) {
      await cdp.send("Page.navigate", { url: groupUrl });
      await sleep(5000);
    } else {
      const searchUrl = `https://www.facebook.com/search/groups?q=${encodeURIComponent(keyword)}`;
      await cdp.send("Page.navigate", { url: searchUrl });
      await sleep(6000);
      const groups = await ev(
        cdp,
        `(() => {
          const links = [...document.querySelectorAll('a[href*="/groups/"]')]
            .filter(a => {
              const href = a.getAttribute('href') || '';
              const r = a.getBoundingClientRect();
              return !href.includes('/groups/you') && r.width > 100 && r.height > 20 && r.bottom > 0 && r.top < innerHeight;
            })
            .map(a => a.href);
          return JSON.stringify([...new Set(links)].slice(0, 5));
        })()`
      );
      const list = groups ? JSON.parse(groups) : [];
      if (!list.length) throw new Error(`未搜到小组（关键词: ${keyword}）`);
      const pick = list[Math.floor(Math.random() * Math.min(list.length, 3))];
      console.log(`[group] 进入小组: ${pick}`);
      await cdp.send("Page.navigate", { url: pick });
      await sleep(6000);
    }

    // 2) 点击群内发布框（"写点什么..."）
    let composerOpen = false;
    for (let i = 0; i < 12 && !composerOpen; i++) {
      composerOpen = (await ev(cdp, `document.querySelectorAll('div[contenteditable=true]').length > 0`)) === true;
      if (composerOpen) break;
      const trig = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div[role=button],div,span')].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return (t.includes('写点什么') || t.includes('分享你的想法') || t.includes('What\\'s on your mind')) && r.width > 100 && r.width < 900 && r.height > 20 && r.bottom > 0 && r.top < innerHeight;
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
      await sleep(900);
    }
    if (!composerOpen) throw new Error("群内发布框没有打开（可能未加入该小组）");
    await sleep(1200);

    // 3) 先传图
    if (files.length) {
      await setFiles(cdp, files);
      console.log(`[group] 已注入 ${files.length} 个附件`);
      let previews = 0;
      for (let i = 0; i < 25; i++) {
        previews = await countAttachments(cdp);
        if (previews >= files.length) break;
        await sleep(1000);
      }
      console.log(`[group] 图片预览数: ${previews}/${files.length}`);
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
    }
    if (!typedOk) throw new Error("群内文案输入失败");
    const imgCount = await countAttachments(cdp);
    console.log(`[group] 发布前校验：文案=有 图片=${imgCount}/${files.length || "无"}`);
    if (files.length && imgCount < 1) throw new Error("图片上传失败");

    // 5) 发帖
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
                return (t === '发布' || t === 'Post' || a === '发布' || a === 'Post' || t === '发帖') && vis(x) && x.getAttribute('aria-disabled') !== 'true';
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
      if (!btn) { await sleep(1500); continue; }
      const b = JSON.parse(btn);
      await clickAt(cdp, b.x + rand(-2, 2), b.y + rand(-2, 2));
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
    }
    if (!posted) throw new Error("群内多次点击发布未生效");
    console.log(`[group] 群内发布成功，耗时 ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-group] ${e.message}`);
  process.exit(1);
});
