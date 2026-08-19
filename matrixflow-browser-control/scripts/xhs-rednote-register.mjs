#!/usr/bin/env node
/**
 * 小红书 / RedNote 网页端注册一条龙（快路径，单 CDP 连接）
 *
 * 用法：
 *   node xhs-rednote-register.mjs request-code <profileId|name> <phone>
 *       # 打开窗口→登录页→选 +351→填号→点获取验证码（一次连接）
 *   node xhs-rednote-register.mjs login-code <profileId|name> <code>
 *       # 填验证码→登录→新手引导（性别/年龄/完成）→确认进入探索页（一次连接）
 *   node xhs-rednote-register.mjs warmup <profileId|name> [seconds]
 *       # 已登录窗口：滚动发现页、点开 1-2 篇笔记停留几秒再关（模拟真人，注册完预热用）
 *   node xhs-rednote-register.mjs open <profileId|name>
 *   node xhs-rednote-register.mjs close <profileId|name>
 *
 * 依赖：MatrixFlow 客户端运行中、本地 API Token 正常（同 mf-browser.mjs）。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 19527;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveDashScopeKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY.trim();
  try {
    const envPath = join(__dirname, "..", "..", "claude-vision-skill", "scripts", ".env");
    if (existsSync(envPath)) {
      const txt = readFileSync(envPath, "utf8");
      const m = txt.match(/^DASHSCOPE_API_KEY\s*=\s*(.+)$/m);
      if (m) return m[1].trim();
    }
  } catch {}
  return "";
}

async function solveRednoteCaptcha(cdp) {
  // 自动解 rednote 选图验证（Security Verification）
  const info = await evalInPage(
    cdp,
    `(() => {
      const win = [...document.querySelectorAll('div')].find(el => /Security Verification|Please select/.test(el.innerText || '') && el.children.length < 30);
      if (!win) return null;
      const lines = (win.innerText || '').split('\\n').filter(l => l && !/Security|Please select|Refresh|Verify|Feedback/.test(l));
      const q = lines[lines.length - 1] || '';
      const imgs = [...win.querySelectorAll('img.grid-item__img')].map(img => img.src);
      return { q, imgs };
    })()`
  );
  if (!info || !info.imgs || info.imgs.length !== 6) return "no-captcha";
  const key = resolveDashScopeKey();
  if (!key) return "no-vision-key";
  const model = process.env.VISION_MODEL || "qwen-vl-max";
  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `下面 6 张图按 1-6 编号（左上=1，从左到右、从上到下）。题干：${info.q}。请只回答符合题干的图片编号，用逗号分隔，例如 "1,5"。` },
            ...info.imgs.map((u) => ({ type: "image_url", image_url: { url: u } })),
          ],
        },
      ],
    }),
  });
  const j = await resp.json().catch(() => ({}));
  const answer = String(j?.choices?.[0]?.message?.content || "");
  const nums = [...answer.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10)).filter((n) => n >= 1 && n <= 6);
  if (!nums.length) return "vision-no-answer:" + answer.slice(0, 60);
  const clicked = await evalInPage(
    cdp,
    `(() => {
      const win = [...document.querySelectorAll('div')].find(el => /Security Verification|Please select/.test(el.innerText || '') && el.children.length < 30);
      if (!win) return 'no-window';
      const tiles = [...win.querySelectorAll('div.grid-item')].filter(el => el.getBoundingClientRect().width > 20);
      const pick = ${JSON.stringify(nums)};
      for (const n of pick) {
        const el = tiles[n - 1];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(t, opts));
        }
      }
      return 'picked:' + pick.join(',');
    })()`
  );
  await sleep(700);
  const verifyState = await evalInPage(
    cdp,
    `(() => {
      const win = [...document.querySelectorAll('div')].find(el => /Security Verification|Please select/.test(el.innerText || '') && el.children.length < 30);
      if (!win) return 'no-window';
      const v = [...win.querySelectorAll('div')].find(el => (el.innerText || '').trim() === 'Verify' && /btn/.test(el.className) && el.getBoundingClientRect().width > 0);
      if (!v) return 'no-verify';
      const r = v.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent;
        v.dispatchEvent(new Ctor(t, opts));
      }
      return 'verified';
    })()`
  );
  await sleep(2500);
  const gone = await evalInPage(
    cdp,
    `![...document.querySelectorAll('div')].some(el => /Security Verification|Please select/.test(el.innerText || '') && el.children.length < 30)`
  );
  return JSON.stringify({ clicked, verifyState, gone, answer: answer.slice(0, 80) });
}

function resolveUserDataRoot() {
  if (process.env.MF_USER_DATA) return process.env.MF_USER_DATA;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "@matrixflow", "desktop");
}

function baseUrl() {
  return (process.env.MF_LOCAL_API || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
}

function resolveToken() {
  if (process.env.MF_LOCAL_API_TOKEN) return process.env.MF_LOCAL_API_TOKEN.trim();
  try {
    const p = join(resolveUserDataRoot(), "local-api-token.txt");
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8").trim();
      if (t) return t;
    }
  } catch {}
  return "";
}

async function api(pathname, { method = "GET", body } = {}) {
  const token = resolveToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-MatrixFlow-Token"] = token;
  const res = await fetch(baseUrl() + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    throw new Error(`API ${method} ${pathname} -> ${res.status}: ${json?.error?.message || res.statusText}`);
  }
  return json;
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

function readPort(profileDir) {
  const first = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0];
  const port = Number.parseInt(first, 10);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid DevToolsActivePort: ${first}`);
  return port;
}

async function resolveProfileId(profile) {
  try {
    const full = await api("/api/v1/profiles");
    const list = full.data?.items || full.data || [];
    const byId = list.find((p) => p.id === profile);
    if (byId) return byId.id;
    const byName = list.find((p) => p.name === profile);
    if (byName) return byName.id;
  } catch {}
  if (/^[A-Za-z0-9_-]{10,}$/.test(profile)) return profile;
  throw new Error(`Profile not found: ${profile}`);
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

async function connectPage(profileId) {
  let dir = findProfileDir(profileId);
  if (!dir) {
    const id = await resolveProfileId(profileId);
    dir = findProfileDir(id);
  }
  if (!dir) throw new Error(`Profile ${profileId} has no DevToolsActivePort. Is it running?`);
  const port = readPort(dir);
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  const targets = await res.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page");
  const page = pages.find((t) => !/browser-start/.test(t.url || "")) || pages[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("No page target");
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => void 0);
  return { cdp, port };
}

async function evalInPage(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`Page JS error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

async function waitReady(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await evalInPage(cdp, "document.readyState")) === "complete") return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

async function openProfile(profileId) {
  const id = await resolveProfileId(profileId);
  await api(`/api/v1/profiles/${encodeURIComponent(id)}/open`, { method: "POST", body: {} });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const dir = findProfileDir(id);
    if (dir) {
      try {
        const port = readPort(dir);
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
        const targets = await res.json();
        if ((Array.isArray(targets) ? targets : []).some((t) => t.type === "page")) break;
      } catch {}
    }
    await sleep(300);
  }
  return id;
}

async function closeProfile(profileId) {
  const id = await resolveProfileId(profileId);
  await api(`/api/v1/profiles/${encodeURIComponent(id)}/close`, { method: "POST" });
  return id;
}

const JS_CLICK = (elExpr) => `
(() => {
  const __el = ${elExpr};
  if (!__el) return 'no-element';
  const r = __el.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return 'zero-rect';
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent;
    __el.dispatchEvent(new Ctor(t, opts));
  }
  return 'clicked';
})()`;

async function cmdRequestCode(profile, phone) {
  const id = await openProfile(profile);
  const { cdp } = await connectPage(id);
  try {
    await cdp.send("Page.navigate", { url: "https://www.rednote.com/login" });
    await waitReady(cdp, 20_000);
    await sleep(2_000);
    await evalInPage(cdp, `document.querySelector('.country-code-select')?.click(); 'ok'`);
    await sleep(900);
    const pt = await evalInPage(
      cdp,
      `(() => { const el = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent.trim() === '葡萄牙' || el.textContent.trim() === 'Portugal') && el.offsetParent !== null); if (!el) return 'no-country'; (el.closest('[class*=country], li, [class*=item]') || el).click(); return 'pt'; })()`
    );
    await sleep(900);
    const phoneVal = await evalInPage(
      cdp,
      `(() => { const input = [...document.querySelectorAll('input')].find(i => i.placeholder === '请输入手机号' || i.placeholder === 'Enter phone number'); if (!input) return 'no-phone-input'; input.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(phone)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return input.value; })()`
    );
    await sleep(300);
    const codeState = await evalInPage(cdp, JS_CLICK("document.querySelector('.code-button')"));
    await sleep(1_500);
    const btnText = await evalInPage(cdp, `(document.querySelector('.auth-code') || {}).innerText || ''`);
    const hasCaptcha = await evalInPage(
      cdp,
      `[...document.querySelectorAll('div')].some(el => /Security Verification|Please select/.test(el.innerText || '') && el.children.length < 30)`
    );
    let captchaResult = "none";
    if (hasCaptcha) {
      captchaResult = await solveRednoteCaptcha(cdp);
      await sleep(1500);
    }
    const btnText2 = await evalInPage(cdp, `(document.querySelector('.auth-code') || {}).innerText || ''`);
    console.log(
      JSON.stringify({
        ok: true,
        profileId: id,
        country: pt,
        phone: phoneVal,
        codeState,
        codeBtn: btnText,
        hasCaptcha,
        captchaResult,
        codeBtnAfter: btnText2,
      })
    );
  } finally {
    cdp.close();
  }
}

async function cmdLoginCode(profile, code) {
  const id = await resolveProfileId(profile);
  const { cdp } = await connectPage(id);
  try {
    const codeVal = await evalInPage(
      cdp,
      `(() => { const input = [...document.querySelectorAll('input')].find(i => i.placeholder === '输入验证码' || i.placeholder === 'Enter verification code'); if (!input) return 'no-code-input'; input.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(code)}); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; })()`
    );
    await sleep(300);
    // 收起可能残留的国家下拉（英文界面下拉有时点不关），避免挡住登录按钮
    await evalInPage(
      cdp,
      `(() => { const isOpen = !!document.querySelector('input[placeholder="Search country/region"], input[placeholder*="国家/地区"]'); if (isOpen) document.querySelector('.country-code-select')?.click(); return 'dismiss:' + isOpen; })()`
    );
    await sleep(400);
    const loginState = await evalInPage(
      cdp,
      `(() => { const btn = [...document.querySelectorAll('button')].find(el => (el.innerText.trim() === '登录' || el.innerText.trim() === 'Log in') && el.offsetParent !== null); if (!btn) return 'no-login-btn'; ${JS_CLICK("btn")}; return 'login-clicked'; })()`
    );
    // 新手引导循环（性别 → 年龄 → 完成 → /explore）
    let phase = "waiting";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(1_200);
      const snapshot = await evalInPage(
        cdp,
        `JSON.stringify({ url: location.href, body: document.body.innerText.slice(0, 160) })`
      );
      let snap = null;
      try {
        snap = JSON.parse(snapshot);
      } catch {
        continue;
      }
      const body = snap.body || "";
      if (/\/explore/.test(snap.url) && !/性别|age/i.test(body)) {
        phase = "done";
        break;
      }
      if (/选择你的性别|Select your gender/i.test(body)) {
        const g = Math.random() < 0.5 ? "女生" : "男生";
        const g2 = g === "女生" ? "Female" : "Male";
        await evalInPage(
          cdp,
          `(() => { const el = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent.trim() === ${JSON.stringify(g)} || el.textContent.trim() === ${JSON.stringify(g2)}) && el.offsetParent !== null); if (!el) return 'no-gender'; ${JS_CLICK("el")}; return 'gender'; })()`
        );
        await sleep(500);
        await evalInPage(
          cdp,
          `(() => { const btn = [...document.querySelectorAll('button')].find(el => (el.innerText.trim() === '继续' || el.innerText.trim() === 'Continue') && el.offsetParent !== null); if (!btn) return 'no-c1'; ${JS_CLICK("btn")}; return 'c1'; })()`
        );
        phase = "gender";
        continue;
      }
      if (/选择你的年龄|Select your age/i.test(body)) {
        const ages = [19, 22, 24, 26, 28, 30, 33];
        const age = String(ages[Math.floor(Math.random() * ages.length)]);
        await evalInPage(
          cdp,
          `(() => { const sel = document.querySelector('.age-ob-wrapper select') || [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.text === '24')); if (!sel) return 'no-age-select'; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, ${JSON.stringify(age)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return 'age=' + sel.value; })()`
        );
        await sleep(400);
        await evalInPage(
          cdp,
          `(() => { const btn = [...document.querySelectorAll('button')].find(el => (el.innerText.trim() === '继续' || el.innerText.trim() === 'Continue') && el.offsetParent !== null); if (!btn) return 'no-c2'; ${JS_CLICK("btn")}; return 'c2'; })()`
        );
        phase = "age";
        continue;
      }
      if (/下载小红书 App|Welcome|欢迎/.test(body) && /完成|Done/.test(body)) {
        await evalInPage(
          cdp,
          `(() => { const el = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent.trim() === '完成' || el.textContent.trim() === 'Done') && el.offsetParent !== null); if (!el) return 'no-done'; ${JS_CLICK("el")}; return 'done'; })()`
        );
        phase = "done-click";
        continue;
      }
    }
    const finalUrl = await evalInPage(cdp, "location.href");
    console.log(JSON.stringify({ ok: true, profileId: id, code: codeVal, loginState, phase, finalUrl }));
  } finally {
    cdp.close();
  }
}

async function cmdWarmup(profile, seconds = 15) {
  const id = await resolveProfileId(profile);
  const { cdp } = await connectPage(id);
  try {
    await cdp.send("Page.navigate", { url: "https://www.rednote.com/explore" });
    await waitReady(cdp, 20_000);
    await sleep(2_500);
    const deadline = Date.now() + Number(seconds) * 1000;
    let notesOpened = 0;
    while (Date.now() < deadline) {
      const clicked = await evalInPage(
      cdp,
        `(() => { const card = [...document.querySelectorAll('section.note-item')].find(c => c.offsetParent !== null && c.getBoundingClientRect().width > 0); if (!card) return 'no-note'; ${JS_CLICK("card")}; return 'opened-note'; })()`
      );
      if (clicked === "opened-note") notesOpened += 1;
      await sleep(4_000 + Math.floor(Math.random() * 6_000));
      await evalInPage(cdp, `document.querySelector('.close-circle')?.click(); 'closed'`).catch(() => void 0);
      await sleep(1_200);
      await evalInPage(cdp, `window.scrollBy(0, ${500 + Math.floor(Math.random() * 500)}); 'scrolled'`);
      await sleep(1_500);
    }
    console.log(JSON.stringify({ ok: true, profileId: id, notesOpened, warmupSeconds: seconds }));
  } finally {
    cdp.close();
  }
}

async function cmdCancelNumber(smsProfile, phone) {
  const { cdp } = await connectPage(smsProfile);
  try {
    const res = await evalInPage(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('table tr')].slice(1);
        const row = rows.find(tr => (tr.cells[0]?.innerText || '').replace(/\\D/g, '').slice(-9) === ${JSON.stringify(phone)});
        if (!row) return 'no-row';
        const btn = [...row.querySelectorAll('button')].find(b => b.querySelector('span.icon-pva__close'));
        if (!btn) return 'no-close-btn';
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent;
          btn.dispatchEvent(new Ctor(t, opts));
        }
        return 'clicked-close';
      })()`
    );
    await sleep(1200);
    const confirm = await evalInPage(
      cdp,
      `(() => {
        const cands = [...document.querySelectorAll('button')].filter(b => /确定|确认|是的|Yes|Cancel|取消/i.test((b.innerText || '').trim()));
        const pos = cands.find(b => /确定|确认|是的|Yes/i.test((b.innerText || '').trim()));
        if (!pos) return 'no-confirm-btn:' + cands.map(b => (b.innerText || '').trim().slice(0, 12)).join('|');
        const r = pos.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent;
          pos.dispatchEvent(new Ctor(t, opts));
        }
        return 'confirmed';
      })()`
    );
    return JSON.stringify({ res, confirm });
  } finally {
    cdp.close();
  }
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  if (cmd === "request-code") {
    if (!arg1 || !arg2) throw new Error("Usage: request-code <profileId|name> <phone>");
    await cmdRequestCode(arg1, arg2);
  } else if (cmd === "login-code") {
    if (!arg1 || !arg2) throw new Error("Usage: login-code <profileId|name> <code>");
    await cmdLoginCode(arg1, arg2);
  } else if (cmd === "warmup") {
    if (!arg1) throw new Error("Usage: warmup <profileId|name> [seconds]");
    await cmdWarmup(arg1, arg2);
  } else if (cmd === "cancel-number") {
    if (!arg1 || !arg2) throw new Error("Usage: cancel-number <heroSmsProfileId> <phone>");
    console.log(await cmdCancelNumber(arg1, arg2));
  } else if (cmd === "open") {
    const id = await openProfile(arg1);
    console.log(JSON.stringify({ ok: true, profileId: id }));
  } else if (cmd === "close") {
    const id = await closeProfile(arg1);
    console.log(JSON.stringify({ ok: true, profileId: id }));
  } else {
    throw new Error(
      "Usage: request-code <profileId> <phone> | login-code <profileId> <code> | warmup <profileId> [seconds] | cancel-number <heroSmsProfileId> <phone> | open|close <profileId>"
    );
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
