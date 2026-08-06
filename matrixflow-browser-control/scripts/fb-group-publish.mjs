#!/usr/bin/env node
/**
 * Facebook 公开小组：加入 ≥N 个 → 访问进入 → 群内发帖（可选匿名）2026-08-07
 *
 * 用法:
 *   node scripts/fb-group-publish.mjs <profileId> --keyword "digital marketing" \
 *     --text-file D:\post.txt [--image D:\a.png] [--join 5] [--anonymous]
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
  await sleep(rand(60, 150));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(60, 140));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function scroll(cdp, delta) {
  await ev(cdp, `window.scrollBy(0, ${delta}); 'ok'`);
  await sleep(rand(1200, 2200));
}

async function findBtn(cdp, texts, minW = 30) {
  return await ev(
    cdp,
    `(() => {
      const list = ${JSON.stringify(texts)};
      const el = [...document.querySelectorAll('div[role=button]')].find(e => {
        const t = (e.textContent || '').trim();
        const r = e.getBoundingClientRect();
        return list.some(k => t === k || t.startsWith(k)) && r.bottom > 0 && r.top < innerHeight && r.width > ${minW};
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const profileId = args[0];
  let keyword = "";
  let textFile = "";
  let image = "";
  let joinTarget = 5;
  let anonymous = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--keyword") keyword = args[++i] || "";
    else if (args[i] === "--text-file") textFile = args[++i] || "";
    else if (args[i] === "--image") image = args[++i] || "";
    else if (args[i] === "--join") joinTarget = Number.parseInt(args[++i], 10) || 5;
    else if (args[i] === "--anonymous") anonymous = true;
  }
  if (!profileId || !keyword || !textFile || !existsSync(textFile)) {
    console.error("用法: fb-group-publish.mjs <profileId> --keyword 关键词 --text-file 文案 [--image 图] [--join 5] [--anonymous]");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const probe = text.slice(0, 8);
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

    // 1) 搜索公开小组
    await cdp.send("Page.navigate", { url: `https://www.facebook.com/search/groups?q=${encodeURIComponent(keyword)}` });
    await sleep(6000);

    // 2) 加入 ≥ N 个小组（点「加入」）
    let joined = 0;
    for (let round = 0; round < 15 && joined < joinTarget; round++) {
      const btn = await findBtn(cdp, ["加入"]);
      if (!btn) { await scroll(cdp, rand(600, 1000)); continue; }
      const b = JSON.parse(btn);
      await clickAt(cdp, b.x, b.y);
      await sleep(rand(1500, 2500));
      joined++;
      console.log(`[group] 加入 ${joined}/${joinTarget}`);
    }
    report.push(`加入小组 ${joined} 个`);

    // 3) 访问第一个已加入的小组（点小组链接进入）
    const groupLink = await ev(
      cdp,
      `(() => {
        const a = [...document.querySelectorAll('a[href*="/groups/"]')].find(x => {
          const r = x.getBoundingClientRect();
          return r.width > 80 && r.height > 20 && r.bottom > 0 && r.top < innerHeight && !(x.getAttribute('href') || '').includes('/groups/you');
        });
        return a ? a.href : null;
      })()`
    );
    if (!groupLink) throw new Error("找不到小组链接");
    await cdp.send("Page.navigate", { url: groupLink });
    await sleep(7000);
    report.push(`进入小组: ${groupLink.slice(0, 60)}`);

    // 4) 打开发帖框（写点什么 / 匿名发帖）
    let composerOpen = false;
    for (let i = 0; i < 12 && !composerOpen; i++) {
      composerOpen = (await ev(cdp, `document.querySelectorAll('div[contenteditable=true]').length > 0`)) === true;
      if (composerOpen) break;
      if (anonymous) {
        const anonBtn = await findBtn(cdp, ["匿名发帖", "Anonymous post"]);
        if (anonBtn) {
          const b = JSON.parse(anonBtn);
          await clickAt(cdp, b.x, b.y);
          await sleep(1500);
        }
      }
      const trig = await findBtn(cdp, ["写点什么", "分享你的想法"], 60);
      if (trig) {
        const t = JSON.parse(trig);
        await clickAt(cdp, t.x, t.y + rand(-4, 4));
      }
      await sleep(1000);
    }
    if (!composerOpen) throw new Error("群内发布框没有打开（可能未加入/需访问）");
    await sleep(1500);

    // 5) 传图（先图后文）
    if (image && existsSync(image)) {
      const doc = await cdp.send("DOM.getDocument", { depth: -1 });
      const q = await cdp.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: 'input[type=file][accept*="image"]',
      });
      if (q.nodeId) {
        await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [image] });
        await sleep(4000);
      }
    }

    // 6) 写文案（真实点击聚焦 + execCommand）
    const pos = await ev(
      cdp,
      `(() => {
        const els = [...document.querySelectorAll('div[contenteditable=true]')]
          .map(e => ({ e, r: e.getBoundingClientRect() }))
          .filter(o => o.r.width > 40)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        const el = els[0] && els[0].e;
        if (!el) return null;
        el.setAttribute('data-mf-gce', '1');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!pos) throw new Error("找不到群内编辑框");
    const p = JSON.parse(pos);
    await clickAt(cdp, p.x, p.y);
    await sleep(400);
    await ev(
      cdp,
      `(() => {
        const el = document.querySelector('[data-mf-gce]');
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
    await sleep(600);
    const typed = (await ev(
      cdp,
      `[...document.querySelectorAll('div[contenteditable=true]')].some(e => (e.innerText || '').includes(${JSON.stringify(probe)}))`
    )) === true;
    if (!typed) throw new Error("群内文案输入失败");
    console.log("[group] 文案已输入");

    // 7) 发布（原生 click）
    let posted = false;
    for (let attempt = 0; attempt < 5 && !posted; attempt++) {
      const btn = await findBtn(cdp, ["发布", "发帖", "Post"]);
      if (!btn) { await sleep(1500); continue; }
      const b = JSON.parse(btn);
      if (attempt === 0) {
        await ev(cdp, `(() => { const el = [...document.querySelectorAll('div[role=button]')].find(e => { const t=(e.textContent||'').trim(); const r=e.getBoundingClientRect(); return (t==='发布'||t==='发帖'||t==='Post') && r.bottom>0 && r.top<innerHeight; }); if (el) el.click(); return true; })()`);
      } else {
        await clickAt(cdp, b.x, b.y);
      }
      await sleep(7000);
      const gone = (await ev(
        cdp,
        `[...document.querySelectorAll('[role=dialog]')].filter(d => d.getBoundingClientRect().width > 300 && d.querySelector('div[contenteditable=true]')).length === 0`
      )) === true;
      if (gone) { posted = true; break; }
    }
    if (!posted) throw new Error("群内多次点击发布未生效");
    report.push("群内已发布（匿名=" + (anonymous ? "是" : "否") + "）");
    console.log(`[group] 完成: ${report.join(" | ")}`);
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-group-publish] ${e.message}`);
  process.exit(1);
});
