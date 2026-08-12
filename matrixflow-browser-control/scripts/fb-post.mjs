#!/usr/bin/env node
/**
 * Facebook 种草帖发布 v5（2026-08-07）
 *
 * 用法：
 *   node scripts/fb-post.mjs <profileSpec> --text-file D:\post.txt \
 *     [--image D:\a.png] [--image D:\b.png] ... [--video D:\v.mp4] \
 *     [--visibility public] [--location "成都" | --random-location] [--no-post]
 *
 * v5 核心修正（解决「要么只有图片、要么只有文字」）：
 *   Facebook 会把发布框渲染成多层叠窗（真实 + 隐藏副本），如果图片进了一
 *   层、文字进了另一层，发出来就是分离的。v5 把【传图、写文、校验、发布】
 *   全部锁定在同一个“可见弹窗”里：
 *     1) 用 elementFromPoint 找到真正在顶层的那层发布框；
 *     2) 图片注入到该层的 input，文案写到该层的编辑框；
 *     3) 发布前校验：同一层里 图片预览数 和 文案探针 必须同时存在；
 *     4) 发布后自动把可见范围改成「公开」（帖子 ⋯ → 公开 → 保存）；
 *     5) 定位：选完必须在该层出现定位标签，失败自动撤销并关面板。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
  const handlers = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.method && handlers.has(msg.method)) {
      const list = handlers.get(msg.method);
      handlers.delete(msg.method);
      for (const h of list) h(msg.params);
      return;
    }
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
    once: (method, handler) => {
      const list = handlers.get(method) || [];
      list.push(handler);
      handlers.set(method, list);
    },
    close: () => { try { ws.close(); } catch {} },
  };
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

// 关闭可能遮挡发布框的系统弹窗（如「创建 PIN 码」/聊天加密提示），避免挡住发布流程
async function dismissOverlays(cdp) {
  for (let round = 0; round < 3; round++) {
    const target = await ev(
      cdp,
      `(() => {
        const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
          const r = x.getBoundingClientRect();
          const t = (x.innerText || '');
          return r.width > 100 && r.bottom > 0 && (t.includes('创建 PIN 码') || t.includes('加密') || t.includes('检查分享对象') || t.includes('更新设置') || /稍后|以后再说|现在不|暂不|跳过/.test(t.slice(0, 200)));
        });
        if (!d) return null;
        const closeBtn = [...d.querySelectorAll('div[role=button]')].find(b => {
          const a = (b.getAttribute('aria-label') || '');
          const t = (b.textContent || '');
          const r = b.getBoundingClientRect();
          return (a.includes('关闭') || /稍后|以后再说|现在不|暂不|跳过|继续|保存|完成/.test(t)) && r.width > 20 && r.bottom > 0 && r.top < innerHeight;
        });
        if (!closeBtn) return null;
        const r = closeBtn.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (!target) return;
    const t = JSON.parse(target);
    await clickAt(cdp, t.x, t.y);
    await sleep(800);
  }
}

// 找到真正在顶层的发布框（elementFromPoint 命中自身才算可见）
async function visibleDialogSelector(cdp, probeText) {
  return await ev(
    cdp,
    `(() => {
      const dialogs = [...document.querySelectorAll('[role=dialog]')]
        .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0
          && !(d.innerText || '').includes('检查分享对象') && !(d.innerText || '').includes('更新设置'));
      const ranked = dialogs.filter(d => (d.innerText || '').includes(${JSON.stringify(probeText || "")}))
        .concat(dialogs);
      for (const d of ranked) {
        // 可见层判定：控件可点（pointer-events 非 none），排除隐藏副本
        const probeBtn = [...d.querySelectorAll('div[role=button]')].find(b => {
          const r = b.getBoundingClientRect();
          return r.width > 20 && r.height > 10 && r.bottom > 0 && r.top < innerHeight;
        });
        if (probeBtn && getComputedStyle(probeBtn).pointerEvents === 'none') continue;
        const r = d.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = Math.min(r.y + 100, r.bottom - 20);
        const topEl = document.elementFromPoint(cx, cy);
        if (!topEl || (!d.contains(topEl) && topEl !== d)) continue;
        d.setAttribute('data-mf-vis', '1');
        return true;
      }
      return false;
    })()`
  );
}

async function attachViaChooser(cdp, files) {
  // 点击可见层的「照片/视频」→ 拦截系统文件选择器 → 注入（图片进顶层弹窗）
  const scriptDir = import.meta.dirname;
  const closeDlg = () => {
    try {
      spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scriptDir, "close-file-dialog.ps1")], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch {}
  };
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  const chooser = new Promise((resolve) => cdp.once("Page.fileChooserOpened", resolve));
  const btn = await ev(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll('[data-mf-vis="1"] div[role=button]')].find(e => {
        const a = (e.getAttribute('aria-label') || '');
        const r = e.getBoundingClientRect();
        return (a === '照片/视频' || a === 'Photo/video' || a === '附加照片或视频') && r.bottom > 0 && r.top < innerHeight && r.width > 20;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!btn) return false;
  const b = JSON.parse(btn);
  await clickAt(cdp, b.x, b.y);
  const event = await Promise.race([
    chooser,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (!event || !event.backendNodeId) {
    // 拦截没生效：很可能弹出了原生 Windows「打开」对话框挡住了浏览器
    console.warn("[fb] 文件选择框未拦截到，关闭可能弹出的系统对话框后重试直接注入");
    closeDlg();
    await sleep(1200);
    return false;
  }
  await cdp.send("DOM.setFileInputFiles", { nodeId: event.backendNodeId, files });
  return true;
}

async function setFilesInVisible(cdp, files) {
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const q = await cdp.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: '[data-mf-vis="1"] input[type=file][accept*="image"], input[type=file][accept*="image"]',
  });
  if (!q.nodeId) throw new Error("找不到图片上传输入框");
  await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files });
}

async function countImagesInVisible(cdp) {
  return (
    (await ev(
      cdp,
      `[...document.querySelectorAll('[data-mf-vis="1"] img')].filter(i => i.naturalWidth > 200).length`
    )) || 0
  );
}

// 在「带图弹窗」里真实点击文字框 → execCommand 输入（实测唯一能图文同框的方式）
async function typeTextInPhotoEditor(cdp, text) {
  const pos = await ev(
    cdp,
    `(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
        const t = (x.innerText || '');
        if (t.includes('检查分享对象') || t.includes('更新设置') || /Reels 现在/.test(t)) return false;
        const big = [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length;
        const ce = [...x.querySelectorAll('div[contenteditable=true]')].filter(e => e.getBoundingClientRect().width > 40).length;
        return big >= 1 && ce >= 1 && x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().width > 300;
      });
      if (!d) return null;
      const ce = [...d.querySelectorAll('div[contenteditable=true]')]
        .filter(e => e.getBoundingClientRect().width > 40)
        .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      if (!ce) return null;
      ce.setAttribute('data-mf-photo-ce', '1');
      const r = ce.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!pos) return false;
  const p = JSON.parse(pos);
  await clickAt(cdp, p.x, p.y); // 真实点击聚焦（不滚动），ProseMirror 才能接受输入
  await sleep(300);
  const focused = await ev(
    cdp,
    `(() => {
      const el = document.querySelector('[data-mf-photo-ce]');
      if (!el) return false;
      el.focus();
      return true;
    })()`
  );
  if (focused) {
    // Lexical/ProseMirror 编辑器对 execCommand 无效，改用 CDP 真实键盘输入
    await cdp.send("Input.insertText", { text });
  }
  await sleep(400);
  return true;
}

async function photoDialogState(cdp, probe) {
  const s = await ev(
    cdp,
    `(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
        const t = (x.innerText || '');
        if (t.includes('检查分享对象') || t.includes('更新设置') || /Reels 现在/.test(t)) return false;
        const big = [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length;
        const ce = [...x.querySelectorAll('div[contenteditable=true]')].filter(e => e.getBoundingClientRect().width > 40).length;
        return big >= 1 && ce >= 1 && x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().width > 300;
      });
      if (!d) return null;
      const imgs = [...d.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length;
      const hasText = [...d.querySelectorAll('div[contenteditable=true]')].some(e => (e.innerText || '').includes(${JSON.stringify(probe)}));
      return JSON.stringify({ imgs, hasText });
    })()`
  );
  return s ? JSON.parse(s) : { imgs: 0, hasText: false };
}

async function setLocationVisible(cdp, location) {
  const btn = await ev(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll('[data-mf-vis="1"] div[role=button]')].find(e => {
        const a = (e.getAttribute('aria-label') || '');
        const r = e.getBoundingClientRect();
        return (a === '签到' || a === 'Check in' || a === '位置') && r.bottom > 0 && r.top < innerHeight && r.width > 20;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!btn) return false;
  const b = JSON.parse(btn);
  await clickAt(cdp, b.x, b.y);
  await sleep(1000);
  const typed = await ev(
    cdp,
    `(() => {
      const input = [...document.querySelectorAll('input')].find(i => {
        const ph = (i.getAttribute('placeholder') || '');
        const r = i.getBoundingClientRect();
        return (ph.includes('搜索') || ph.includes('地点')) && r.bottom > 0 && r.top < innerHeight && r.width > 100;
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
  await sleep(1500);
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
  if (!option) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    return false;
  }
  const o = JSON.parse(option);
  await clickAt(cdp, o.x, o.y);
  await sleep(800);
  const ok = (await ev(
    cdp,
    `(() => {
      const chip = [...document.querySelectorAll('[data-mf-vis="1"] span, [data-mf-vis="1"] div')].some(e => (e.textContent || '').trim() === ${JSON.stringify(location)});
      const panel = [...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText || '').includes('搜索地点'));
      return JSON.stringify({ chip, panelStillOpen: panel });
    })()`
  ));
  const r = ok ? JSON.parse(ok) : { chip: false, panelStillOpen: false };
  if (!r.chip || r.panelStillOpen) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(500);
    return false;
  }
  return true;
}

async function setPostPublic(cdp, probeText) {
  // 发布后把帖子改成公开：定位帖子 → 编辑分享对象 → 公开 → 保存
  const arts = await ev(
    cdp,
    `(() => {
      const a = [...document.querySelectorAll('[role=article]')].find(x => {
        const t = (x.innerText || '');
        const r = x.getBoundingClientRect();
        return t.includes(${JSON.stringify(probeText)}) && r.bottom > -50 && r.top < innerHeight + 50;
      });
      if (!a) return null;
      a.scrollIntoView({ block: 'center' });
      const ar = a.getBoundingClientRect();
      const btn = [...document.querySelectorAll('div[role=button]')].find(e => {
        const a2 = (e.getAttribute('aria-label') || '');
        const r = e.getBoundingClientRect();
        return a2 === '编辑分享对象' && r.bottom > 0 && r.top < innerHeight && Math.abs(r.top - ar.top) < 180;
      });
      if (!btn) return null;
      btn.setAttribute('data-mf-pub-post', '1');
      const r = btn.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (!arts) return false;
  const p = JSON.parse(arts);
  await clickAt(cdp, p.x, p.y);
  await sleep(1200);
  // 选公开（第一个 radio 通常是公开）
  const radio = await ev(
    cdp,
    `(() => {
      const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText || '').includes('谁能看到你的帖子'));
      const r = dlg ? dlg.querySelector('input[type=radio]') : null;
      if (!r) return null;
      r.setAttribute('data-mf-pub-radio', '1');
      const rr = r.getBoundingClientRect();
      return JSON.stringify({ x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 });
    })()`
  );
  if (radio) {
    const r2 = JSON.parse(radio);
    await clickAt(cdp, r2.x, r2.y);
    await sleep(800);
  }
  const save = await ev(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll('div[role=button]')].find(e => {
        const a = (e.getAttribute('aria-label') || '');
        const r = e.getBoundingClientRect();
        return a === '保存隐私分享对象选择并关闭对话框' && r.bottom > 0 && r.top < innerHeight && r.width > 30;
      });
      if (!el) return null;
      el.setAttribute('data-mf-pub-save', '1');
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`
  );
  if (save) {
    const s = JSON.parse(save);
    await clickAt(cdp, s.x, s.y);
    await sleep(1000);
  }
  return true;
}

// 发布前：在发布框内把可见范围设为「公开」（作用在带图弹窗上，点完再验证）
async function setComposerPublic(cdp, probe) {
  // 重试 3 次：首次可能因隐私弹窗渲染时序未就绪导致点空
  for (let attempt = 0; attempt < 3; attempt++) {
    const priv = await ev(
      cdp,
      `(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')]
          .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
        const d = dialogs.find(x => !(x.innerText || '').includes('检查分享对象') && !(x.innerText || '').includes('更新设置') && [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length >= 1)
          || dialogs.find(x => (x.innerText || '').includes(${JSON.stringify(probe)}))
          || dialogs[0];
        if (!d) return null;
        const btn = [...d.querySelectorAll('div[role=button]')].find(e => {
          const a = (e.getAttribute('aria-label') || '');
          const r = e.getBoundingClientRect();
          return a.startsWith('编辑隐私设置') && r.bottom > 0 && r.top < innerHeight && r.width > 20;
        });
        if (!btn) return null;
        btn.setAttribute('data-mf-privc', '1');
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (priv) {
      const p = JSON.parse(priv);
      await clickAt(cdp, p.x, p.y);
      await sleep(1200);
    }
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
        // 关键：点「公开」行内的单选圆点（实测点整行不生效，点 radio 才生效）
        const radio = el.querySelector('input[type=radio]');
        const r = radio ? radio.getBoundingClientRect() : el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`
    );
    if (pubRow) {
      const u = JSON.parse(pubRow);
      await clickAt(cdp, u.x, u.y);
      await sleep(1200);
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
      await sleep(1200);
    }
    // 验证发布框可见范围
    const label = await ev(
      cdp,
      `(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')]
          .filter(d => d.getBoundingClientRect().width > 300 && d.getBoundingClientRect().bottom > 0);
        const d = dialogs.find(x => !(x.innerText || '').includes('检查分享对象') && !(x.innerText || '').includes('更新设置') && [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length >= 1)
          || dialogs.find(x => (x.innerText || '').includes(${JSON.stringify(probe)}));
        if (!d) return '';
        const btn = [...d.querySelectorAll('div[role=button]')].find(e => {
          const a = (e.getAttribute('aria-label') || '');
          const r = e.getBoundingClientRect();
          return a.startsWith('编辑隐私设置') && r.width > 20;
        });
        return btn ? (btn.getAttribute('aria-label') || '') : '';
      })()`
    );
    const ok = /公开|Public/.test(label || "");
    console.log(`[fb] 发布前可见范围: ${label || "未知"} ${ok ? "✅ 公开" : "❌ 未公开"}${attempt > 0 ? `（第 ${attempt + 1} 次尝试）` : ""}`);
    if (ok) return true;
    // 未成功：如果隐私菜单还开着，先按 Esc / 点完成关闭，再重试
    await ev(cdp, `(() => { const b = document.querySelector('[data-mf-privc="1"]'); if (b) b.click(); return true; })()`).catch(() => {});
    await sleep(600);
  }
  return false;
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

// 自动挑选未用过的图片（2026-08-11 新增）：扫描素材文件夹，避开最近用过的，保证每次配图不一样
function autoPickImages(count = 1) {
  const userData = resolveUserDataRoot();
  const usedPath = join(userData, "fb-images-used.json");
  const used = existsSync(usedPath) ? JSON.parse(readFileSync(usedPath, "utf8") || "[]") : [];
  const usedSet = new Set(used.map((p) => String(p).toLowerCase()));
  const home = homedir();
  const folders = [
    process.env.FB_IMAGES_DIR,
    join(home, "Documents", "ShareX", "Screenshots"),
    join(home, "Downloads"),
    join(home, "Pictures"),
    join(userData, "fb-images"),
  ].filter(Boolean);
  const exts = /\.(png|jpe?g|webp|gif)$/i;
  const candidates = [];
  const collect = (folder, depth, includeUsed = false) => {
    if (!existsSync(folder) || depth > 3) return;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(folder, e.name);
      if (e.isDirectory()) {
        collect(full, depth + 1);
      } else if (e.isFile() && exts.test(e.name)) {
        if (includeUsed || !usedSet.has(String(full).toLowerCase())) candidates.push(full);
      }
    }
  };
  for (const folder of folders) collect(folder, 0);
  if (!candidates.length) {
    console.warn("[fb] 素材文件夹里没有未用过的图片，回退到全部图片（含已用）");
    for (const folder of folders) collect(folder, 0, true);
  }
  // 随机洗牌取 count 张
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const picked = candidates.slice(0, count);
  if (picked.length) {
    const now = used.concat(picked.map((p) => String(p)));
    writeFileSync(usedPath, JSON.stringify(now.slice(-200)), "utf8");
    console.log(`[fb] 自动挑图 ${picked.length} 张（素材库共 ${candidates.length} 张未用图）`);
  } else {
    console.warn("[fb] 没有找到可用图片，将发纯文字帖");
  }
  return picked;
}

async function main() {
  const args = process.argv.slice(2);
  const profileSpec = args[0];
  if (!profileSpec) {
    console.error("用法: fb-post.mjs <profileSpec> --text-file <path> [--image ...] [--video ...] [--visibility public] [--location 地点 | --random-location] [--no-post]");
    process.exit(1);
  }
  let textFile = "";
  const images = [];
  let video = "";
  let visibility = "";
  let location = "";
  let randomLocation = false;
  let noPost = false;
  let multi = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--text-file") textFile = args[++i] || "";
    else if (args[i] === "--image") images.push(args[++i] || "");
    else if (args[i] === "--video") video = args[++i] || "";
    else if (args[i] === "--visibility") visibility = args[++i] || "";
    else if (args[i] === "--location") location = args[++i] || "";
    else if (args[i] === "--random-location") randomLocation = true;
    else if (args[i] === "--no-post") noPost = true;
    else if (args[i] === "--multi") multi = true;
  }
  if (!textFile || !existsSync(textFile)) {
    console.error("请提供存在的 --text-file");
    process.exit(1);
  }
  const text = readFileSync(textFile, "utf8").trim();
  const probe = text.slice(0, 8);
  // 图片策略（2026-08-11 优化）：
  // - 没指定图片时自动从素材文件夹挑，且避开最近用过的图（保证每次图片不一样）
  // - 默认 1 张（FB 多图易触发「内容冲突」）；显式 --multi 时才允许最多 3 张
  let files = [];
  if (!images.length && !video) {
    files = autoPickImages(multi ? 3 : 1);
  } else {
    files = [...images, ...(video ? [video] : [])].filter((f) => f && existsSync(f));
  }
  if (files.length > 3) files = files.slice(0, 3);
  if (!multi && files.length > 1 && !video) {
    console.log(`[fb] 未启用 --multi，本帖使用第 1 个附件: ${files[0].split(/[\\/]/).pop()}`);
    files = files.slice(0, 1);
  }
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
    // 2026-08-11：先关掉可能残留/弹出的系统「打开」文件对话框，避免挡住后续操作
    try {
      const scriptDir = import.meta.dirname;
      spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scriptDir, "close-file-dialog.ps1")], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch {}
    // 全程拦截系统文件选择对话框（防止弹出 Windows 文件窗口）
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
    const url = await ev(cdp, "location.href");
    // 2026-08-11 修复：必须回到首页发布框。之前只在非 facebook.com 时导航，
    // 如果标签页停在搜索页/帖子页就会一直找不到发布框。
    if (!/facebook\.com\/\??$/.test(url || "")) {
      await cdp.send("Page.navigate", { url: "https://www.facebook.com/" });
      await sleep(4500);
    }

    // 1) 打开发布框（先关掉可能遮挡的弹窗，如「创建 PIN 码」提示）
    await dismissOverlays(cdp);
    let composerOpen = false;
    for (let i = 0; i < 20 && !composerOpen; i++) {
      composerOpen = (await ev(cdp, `[...document.querySelectorAll('div[contenteditable=true]')].some(e => e.getBoundingClientRect().width > 100 && e.getBoundingClientRect().bottom > 0)`)) === true;
      if (composerOpen) break;
      const trig = await ev(
        cdp,
        `(() => {
          const find = (role) => [...document.querySelectorAll(role)].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return (t.includes('分享你的新鲜事') || t.includes('分享想法')) && r.width > 100 && r.width < 900 && r.bottom > 0 && r.top < innerHeight;
          });
          const el = find('div[role=button]') || find('[role=button]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (trig) {
        const t = JSON.parse(trig);
        await clickAt(cdp, t.x, t.y + rand(-4, 4));
      } else {
        // 兜底：直接点页面顶部「创建帖子」区域（新界面有时不是 role=button）
        await ev(cdp, `(() => {
          const el = [...document.querySelectorAll('div')].find(e => {
            const t = (e.textContent || '').trim();
            const r = e.getBoundingClientRect();
            return t.startsWith('创建帖子') && t.includes('分享你的新鲜事') && r.width > 400 && r.width < 800 && r.height > 30 && r.height < 100 && r.bottom > 0 && r.top < innerHeight;
          });
          if (!el) return false;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
          el.click();
          return true;
        })()`);
      }
      await sleep(800);
    }
    if (!composerOpen) throw new Error("发布框没有打开");
    await sleep(1200);

    // 2) 锁定顶层可见发布框
    // 2026-08-12：部分账号打开发布框时会弹 Reels「检查分享对象/更新设置」引导，先清掉再锁定
    await dismissOverlays(cdp);
    const vis = await visibleDialogSelector(cdp, "");
    if (!vis) throw new Error("找不到可见发布框");
    console.log("[fb] 已锁定顶层发布框");

    // 3) 先传图（注入到可见层）
    if (files.length) {
      const viaChooser = await attachViaChooser(cdp, files);
      if (!viaChooser) {
        await setFilesInVisible(cdp, files);
        console.log(`[fb] 已通过输入框注入 ${files.length} 个附件`);
      } else {
        console.log(`[fb] 已通过照片按钮注入 ${files.length} 个附件（顶层弹窗）`);
      }
      let n = 0;
      for (let i = 0; i < 30; i++) {
        n = await countImagesInVisible(cdp);
        if (n >= files.length) break;
        await sleep(600);
      }
      console.log(`[fb] 可见层图片预览: ${n}/${files.length}`);
      // 传图后 Facebook 可能新开「照片编辑器」弹窗：重新锁定带图的那一层
      const reVis = await ev(
        cdp,
        `(() => {
          const baseName = ${JSON.stringify(files[0].split(/[\\/]/).pop().toLowerCase())};
          const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
            const imgs = [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 300 || (i.alt || '').toLowerCase().includes(baseName)).length;
            return imgs >= 1 && x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().width > 300;
          });
          if (!d) return false;
          d.setAttribute('data-mf-vis', '1');
          return true;
        })()`
      );
      if (reVis) console.log("[fb] 已切换到带图弹窗");
      // 清理多余附件（避免内容冲突）
      for (let i = 0; i < 6; i++) {
        const cur = await countImagesInVisible(cdp);
        if (cur <= files.length) break;
        const rm = await ev(
          cdp,
          `(() => {
            const btn = [...document.querySelectorAll('[data-mf-vis="1"] div[role=button]')].find(e => {
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
      await sleep(500);
    }

    // 4) 后写文案（写入「带图弹窗」的文字框）
    let typedOk = false;
    for (let attempt = 0; attempt < 3 && !typedOk; attempt++) {
      await dismissOverlays(cdp);
      await typeTextInPhotoEditor(cdp, text);
      const st = await photoDialogState(cdp, probe);
      typedOk = st.hasText;
    }
    if (!typedOk) throw new Error("文案写入带图弹窗失败");
    console.log("[fb] 文案已写入带图弹窗");

    // 5) 发布前校验：同一个「带图弹窗」里 图文都在
    const st5 = await photoDialogState(cdp, probe);
    console.log(`[fb] 发布前校验（带图弹窗）：文案=${st5.hasText ? "有" : "无"} 图片=${st5.imgs}/${files.length || "无"}`);
    if (!st5.hasText) throw new Error("发布前校验失败：文案不在带图弹窗");
    if (files.length && st5.imgs < 1) throw new Error("发布前校验失败：图片不在带图弹窗");

    // 6) 定位（同一层，失败安全撤销）
    if (finalLocation) {
      const locOk = await setLocationVisible(cdp, finalLocation);
      console.log(`[fb] 定位「${finalLocation}」: ${locOk ? "成功" : "失败（已撤销，不影响发布）"}`);
    }

    // 7) 发布
    if (noPost) {
      console.log("[fb] 内容已就绪（--no-post），跳过发布");
      return;
    }
    // 7.1) 发布前设公开（先设好再点发布，不再发完再改）
    if (visibility === "public") {
      const pubOk = await setComposerPublic(cdp, probe);
      if (!pubOk) console.log("[fb] 发布前设公开失败，继续发布（发布后需人工检查）");
    }
    let posted = false;
    for (let attempt = 0; attempt < 6 && !posted; attempt++) {
      // 发布前复检（定位等步骤可能改变叠层）
      const stNow = await photoDialogState(cdp, probe);
      console.log(`[fb] 发布前复检（第 ${attempt + 1} 次）：文案=${stNow.hasText ? "有" : "无"} 图片=${stNow.imgs}`);
      if (files.length && stNow.imgs < 1) {
        if (attempt < 2) {
          console.log("[fb] 图片丢失，重新注入");
          await setFilesInVisible(cdp, files);
          await sleep(3000);
        }
        continue;
      }
      const btn = await ev(
        cdp,
        `(() => {
          const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
            const big = [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length;
            return big >= 1 && x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().width > 300;
          });
          if (!d) return null;
          const vis2 = o => { const r = o.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 30; };
          const b = [...d.querySelectorAll('div[role=button]')]
            .filter(x => {
              const t = (x.textContent || '').trim();
              const a = (x.getAttribute('aria-label') || '').trim();
              return (t === '发帖' || t === 'Post' || a === '发帖' || a === 'Post') && vis2(x) && x.getAttribute('aria-disabled') !== 'true';
            })
            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
          if (!b) return null;
          b.setAttribute('data-mf-go', '1');
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
      );
      if (!btn) { await sleep(1500); continue; }
      const b = JSON.parse(btn);
      if (attempt === 0) {
        await ev(cdp, `(() => { const el = document.querySelector('[data-mf-go="1"]'); if (el) el.click(); return true; })()`);
      } else {
        await clickAt(cdp, b.x + rand(-2, 2), b.y + rand(-2, 2));
      }
      await sleep(7000);
      // 判定：带图弹窗消失 = 已提交发布（不要再重试，避免误发重复帖）
      const photoGone = (await ev(
        cdp,
        `(() => {
          const d = [...document.querySelectorAll('[role=dialog]')].find(x => {
            const big = [...x.querySelectorAll('img')].filter(i => i.naturalWidth > 200).length;
            return big >= 1 && x.getBoundingClientRect().bottom > 0 && x.getBoundingClientRect().width > 300;
          });
          return !d;
        })()`
      )) === true;
      const composerGone = (await ev(
        cdp,
        `[...document.querySelectorAll('[role=dialog]')].filter(d => d.getBoundingClientRect().width > 300 && d.querySelector('div[contenteditable=true]')).length === 0`
      )) === true;
      if (photoGone || composerGone) {
        posted = true;
        console.log("[fb] 发布框已关闭，视为提交成功");
        break;
      }
      // 未确认时去个人主页核实（防止误报失败导致重发）
      if (attempt === 0) {
        await cdp.send("Page.navigate", { url: "https://www.facebook.com/me" });
        await sleep(5000);
        const confirmed = (await ev(
          cdp,
          `[...document.querySelectorAll('[role=article]')].some(a => (a.innerText || '').includes(${JSON.stringify(probe)}))`
        )) === true;
        if (confirmed) {
          posted = true;
          console.log("[fb] 已在个人主页确认发布");
          break;
        }
      }
      else console.log(`[fb] 第 ${attempt + 1} 次点击未生效，重试`);
    }
    if (!posted) throw new Error("多次点击发布未生效");
    console.log(`[fb] 发布成功，耗时 ${Math.round((Date.now() - started) / 1000)}s`);

    // 8) 发布后清理：关掉可能残留的系统对话框/空弹窗
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

    hist.push({ at: new Date().toISOString(), snippet: text.slice(0, 100) });
    writeFileSync(join(resolveUserDataRoot(), "fb-post-history.json"), JSON.stringify(hist, null, 2), "utf8");
    console.log("[fb] 已记录发布历史");
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[fb-post] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
