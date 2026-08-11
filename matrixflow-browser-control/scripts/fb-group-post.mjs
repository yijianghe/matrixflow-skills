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
    selector: '[role=dialog] input[type=file][accept*="image"]',
  });
  if (!q.nodeId) {
    const q2 = await cdp.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file][accept*="image"]',
    });
    if (!q2.nodeId) throw new Error("找不到图片上传输入框");
    await cdp.send("DOM.setFileInputFiles", { nodeId: q2.nodeId, files });
    return;
  }
  await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files });
}

async function countAttachments(cdp) {
  return (
    (await ev(
      cdp,
      `(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
        const withComposer = dialogs.find(d => (d.innerText || '').includes('添加更多内容')) || dialogs[0];
        if (withComposer) return [...withComposer.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length;
        return 0;
      })()`
    )) || 0
  );
}

// 处理群「互动必答题」：选 Both + Yes，同意规则，提交（很多公开群首次发帖需要）
async function handleGroupQuestions(cdp) {
  const positive = ["Both", "两者", "Yes", "是", "Agree", "同意", "我同意", "是，我同意", "是的", "Buyer", "买家"];
  for (let pass = 0; pass < 15; pass++) {
    const action = await ev(
      cdp,
      `(() => {
        const positive = ${JSON.stringify(positive)};
        const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
          const t = (x.innerText || '');
          const r = x.getBoundingClientRect();
          return r.width > 300 && r.bottom > 0 && (t.includes('互动必答题') || t.includes('首先请提交互动请求'));
        });
        if (!d) return 'none';
        const vis = (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 20 && r.height > 10 && r.bottom > 0 && r.top < innerHeight;
        };
        // 1) 找一个未选中的正面选项 label，返回中心坐标（由外层真实鼠标点击）
        for (const text of positive) {
          for (const opt of [...d.querySelectorAll('label')]) {
            const t = (opt.textContent || '').trim();
            const input = opt.querySelector('input');
            if (t === text && vis(opt) && input && input.type === 'checkbox' && !input.checked) {
              const r = opt.getBoundingClientRect();
              return JSON.stringify({ action: 'click', x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }
          }
        }
        // 2) 找未勾选的同意规则 checkbox
        for (const opt of [...d.querySelectorAll('label')]) {
          const t = (opt.textContent || '').trim();
          const input = opt.querySelector('input');
          if (/^我同意小组规则$|^同意小组规则$|^我同意$|^I agree$|^Agree$/.test(t) && input && input.type === 'checkbox' && !input.checked && vis(opt)) {
            const r = opt.getBoundingClientRect();
            return JSON.stringify({ action: 'click', x: r.x + r.width / 2, y: r.y + r.height / 2 });
          }
        }
        // 3) 滚动弹窗内容露出更多选项
        for (const s of [...d.querySelectorAll('*')]) {
          if (s.scrollHeight > s.clientHeight + 20 && s.clientHeight > 100 && s.scrollTop < s.scrollHeight - s.clientHeight - 5) {
            s.scrollTop += 300;
            return JSON.stringify({ action: 'scrolled' });
          }
        }
        // 4) 点可用的提交按钮（注意可能有禁用副本，要 aria-disabled 非 true 的那个）
        const submit = [...d.querySelectorAll('div[role=button]')].find(e => {
          const t = (e.textContent || '').trim();
          return (t === '提交' || t === 'Submit') && vis(e) && e.getAttribute('aria-disabled') !== 'true';
        });
        if (submit) {
          const r = submit.getBoundingClientRect();
          return JSON.stringify({ action: 'submit', x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
        return JSON.stringify({ action: 'stuck' });
      })()`
    );
    if (action === 'none') return true;
    const parsed = JSON.parse(action);
    if (parsed.action === 'stuck') return false;
    if (parsed.action === 'scrolled') { await sleep(900); continue; }
    if (parsed.action === 'click' || parsed.action === 'submit') {
      await clickAt(cdp, parsed.x, parsed.y);
      console.log(`[group] 互动题: ${parsed.action}`);
    }
    await sleep(1200);
  }
  return true;
}

async function typeText(cdp, text) {
  const pos = await ev(
    cdp,
    `(() => {
      const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
      const withImg = dialogs.find(d => [...d.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length >= 1);
      const source = withImg || dialogs.find(d => (d.innerText || '').includes('添加更多内容')) || null;
      const els = [...(source || document).querySelectorAll('div[contenteditable=true]')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(o => o.r.width > 100 && o.r.height >= 15)
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
      const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
      const withImg = dialogs.find(d => [...d.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length >= 1);
      const source = withImg || dialogs.find(d => (d.innerText || '').includes('添加更多内容')) || null;
      const els = [...(source || document).querySelectorAll('div[contenteditable=true]')]
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
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""))
    || (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
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
      let list = [];
      for (let attempt = 0; attempt < 5 && !list.length; attempt++) {
        await sleep(attempt === 0 ? 7000 : 3000);
        const groups = await ev(
          cdp,
          `(() => {
            const links = [...document.querySelectorAll('a[href*="/groups/"]')]
              .filter(a => {
                const href = a.href || a.getAttribute('href') || '';
                const r = a.getBoundingClientRect();
                const m = href.match(/facebook\\.com\\/groups\\/([A-Za-z0-9._-]+)/);
                const groupId = m ? m[1] : '';
                const bad = ['you', 'feed', 'discover', 'requests', 'invites', 'bookmarks', 'saved', 'settings', 'create', 'joined', 'pinned', 'search'];
                return groupId.length > 2 && !bad.includes(groupId.toLowerCase()) && !href.includes('?q=') && r.width > 50 && r.height > 15 && r.bottom > 0 && r.top < innerHeight;
              })
              .map(a => a.href);
            return JSON.stringify([...new Set(links)].slice(0, 5));
          })()`
        );
        list = groups ? JSON.parse(groups) : [];
      }
      if (!list.length) throw new Error(`未搜到小组（关键词: ${keyword}）`);
      const pick = list[Math.floor(Math.random() * Math.min(list.length, 3))];
      console.log(`[group] 进入小组: ${pick}`);
      await cdp.send("Page.navigate", { url: pick });
      await sleep(6000);
    }

    // 1.5) 未加入的小组先点「加入小组」再加入（之后才能发帖）
    for (let joinTry = 0; joinTry < 3; joinTry++) {
      const joinBtn = await ev(
        cdp,
        `(() => {
          const btn = [...document.querySelectorAll('[role=button]')].find(b => {
            const t = (b.textContent || '').trim();
            const r = b.getBoundingClientRect();
            return (t === '加入小组' || t === 'Join Group' || /^加入小组$/.test(t)) && r.width > 50 && r.height > 20 && r.bottom > 0 && r.top < innerHeight;
          });
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (!joinBtn) {
        await sleep(2500);
        continue;
      }
      const jb = JSON.parse(joinBtn);
      await clickAt(cdp, jb.x, jb.y);
      console.log("[group] 已点击「加入小组」");
      await sleep(4000);
    }

    // 2) 点击群内发布框（"写点什么..."）
    let composerOpen = false;
    for (let i = 0; i < 12 && !composerOpen; i++) {
      // 有些公开群首次发帖会弹「互动必答题」，先处理掉
      if (i === 0 || i === 4 || i === 8) {
        await handleGroupQuestions(cdp);
      }
      composerOpen = (await ev(cdp, `[...document.querySelectorAll('div[contenteditable=true]')].some(e => e.getBoundingClientRect().width > 300 && e.getBoundingClientRect().height > 20)`)) === true;
      if (composerOpen) break;
      const trig = await ev(
        cdp,
        `(() => {
          const vis = (e) => {
            const r = e.getBoundingClientRect();
            return r.width > 50 && r.width < 900 && r.height > 15 && r.bottom > 0 && r.top < innerHeight;
          };
          const exact = [...document.querySelectorAll('div[role=button]')].find(e => {
            const t = (e.textContent || '').trim();
            return (t === '写点什么...' || t === '写点什么') && vis(e);
          });
          const el = exact || [...document.querySelectorAll('div[role=button],div,span')]
            .filter(e => {
              const t = (e.textContent || '').trim();
              const r = e.getBoundingClientRect();
              return (t.includes('写点什么') || t.includes('分享你的想法') || t.includes('What\\'s on your mind')) && r.width > 100 && r.width < 900 && r.height > 20 && r.bottom > 0 && r.top < innerHeight;
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
      if (trig) {
        const t = JSON.parse(trig);
        await clickAt(cdp, t.x, t.y + rand(-4, 4));
      }
      await sleep(900);
    }
    // 2.5) 已加入但发布框仍是内嵌未展开时，点击「写点什么」正文区
    if (!composerOpen) {
      const trig2 = await ev(
        cdp,
        `(() => {
          const el = [...document.querySelectorAll('div[role=button]')].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return (t === '写点什么...' || t === '写点什么') && r.width > 100 && r.width < 900 && r.bottom > 0 && r.top < innerHeight;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (trig2) {
        const t = JSON.parse(trig2);
        await clickAt(cdp, t.x, t.y + rand(-4, 4));
        await sleep(1200);
        composerOpen = (await ev(cdp, `[...document.querySelectorAll('div[contenteditable=true]')].some(e => e.getBoundingClientRect().width > 300 && e.getBoundingClientRect().height > 20)`)) === true;
      }
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
