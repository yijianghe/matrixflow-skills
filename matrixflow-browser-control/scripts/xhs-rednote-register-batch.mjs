#!/usr/bin/env node
/**
 * 小红书/RedNote 并发注册编排（2026-08-18 新增）
 *
 * 用法：
 *   node xhs-rednote-register-batch.mjs request-codes "<pairs>"
 *       # pairs = profileId|phone,profileId|phone,...  并发开窗+发验证码
 *   node xhs-rednote-register-batch.mjs wait-login "<pairs>" --sms <heroSmsProfileId> [--timeout 420]
 *       # 轮询 hero-sms 收码，谁到了就并发填码登录+过引导，直到全部完成
 *   node xhs-rednote-register-batch.mjs warmup-all "<pairs>" [seconds]
 *       # 逐个预热浏览（默认 12 秒），不关窗（关窗由调用方 close）
 *
 * 依赖：MatrixFlow 客户端运行中、本地 API Token 正常、hero-sms 窗口已登录且已买好号码。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 19527;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function parsePairs(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [profile, phone] = s.split("|").map((x) => x.trim());
      return { profile, phone };
    });
}

async function requestCodeFor(profile, phone) {
  const id = await openProfile(profile);
  const { cdp } = await connectPage(id);
  try {
    await cdp.send("Page.navigate", { url: "https://www.rednote.com/login" });
    await waitReady(cdp, 20_000);
    await sleep(2_000);
    await evalInPage(cdp, `document.querySelector('.country-code-select')?.click(); 'ok'`);
    await sleep(900);
    await evalInPage(
      cdp,
      `(() => { const el = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent.trim() === '葡萄牙' || el.textContent.trim() === 'Portugal') && el.offsetParent !== null); if (!el) return 'no-country'; (el.closest('[class*=country], li, [class*=item]') || el).click(); return 'pt'; })()`
    );
    await sleep(900);
    await evalInPage(
      cdp,
      `(() => { const input = [...document.querySelectorAll('input')].find(i => i.placeholder === '请输入手机号' || i.placeholder === 'Enter phone number'); if (!input) return 'no-phone-input'; input.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(phone)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return input.value; })()`
    );
    await sleep(300);
    await evalInPage(cdp, JS_CLICK("document.querySelector('.code-button')"));
    await sleep(1_200);
    const btnText = await evalInPage(cdp, `(document.querySelector('.auth-code') || {}).innerText || ''`);
    const hasCaptcha = await evalInPage(
      cdp,
      `[...document.querySelectorAll('div')].some(el => /Security Verification|Please select/.test(el.innerText || '') && el.children.length < 30)`
    );
    return { profileId: id, phone, codeBtn: btnText, hasCaptcha };
  } finally {
    cdp.close();
  }
}

async function loginCodeFor(profile, code) {
  const { cdp } = await connectPage(profile);
  try {
    await evalInPage(
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
    await evalInPage(
      cdp,
      `(() => { const btn = [...document.querySelectorAll('button')].find(el => (el.innerText.trim() === '登录' || el.innerText.trim() === 'Log in') && el.offsetParent !== null); if (!btn) return 'no-login-btn'; ${JS_CLICK("btn")}; return 'login-clicked'; })()`
    );
    let phase = "waiting";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(1_200);
      let snap = null;
      try {
        snap = JSON.parse(
          await evalInPage(cdp, `JSON.stringify({ url: location.href, body: document.body.innerText.slice(0, 160) })`)
        );
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
    return { profileId: profile, code, phase, finalUrl };
  } finally {
    cdp.close();
  }
}

async function warmupFor(profile, seconds) {
  const { cdp } = await connectPage(profile);
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
    return { profileId: profile, notesOpened };
  } finally {
    cdp.close();
  }
}

async function readSmsCodes(smsProfile) {
  const { cdp } = await connectPage(smsProfile);
  try {
    // 直接按「我的购买」表格逐行解析：第1列号码、第5列验证码（比正则靠谱）
    const parsed = await evalInPage(
      cdp,
      `(() => {
        const out = {};
        for (const t of document.querySelectorAll('table')) {
          for (const tr of t.rows) {
            const cells = [...tr.cells];
            if (!cells.length) continue;
            const phoneCell = (cells[0] || {}).innerText || '';
            const digits = phoneCell.replace(/\\D/g, '');
            if (digits.length < 9) continue;
            const nine = digits.slice(-9);
            // 验证码在「状况」列里：已接受短信\\n短信验证码:\\n127367\\n1
            const statusText = cells.map((c) => ((c || {}).innerText || '')).join('\\n');
            const m = statusText.match(/短信验证码:\\s*(\\d{4,8})/);
            const code = m ? m[1] : '';
            if (code) out[nine] = code;
          }
        }
        return out;
      })()`
    );
    return parsed || {};
  } finally {
    cdp.close();
  }
}

async function cmdRequestCodes(pairsRaw) {
  const pairs = parsePairs(pairsRaw);
  if (!pairs.length) throw new Error("no pairs");
  const results = [];
  for (let i = 0; i < pairs.length; i += 3) {
    const chunk = pairs.slice(i, i + 3);
    const res = await Promise.all(chunk.map((p) => requestCodeFor(p.profile, p.phone).catch((e) => ({ profile: p.profile, phone: p.phone, error: String(e.message || e) }))));
    results.push(...res);
  }
  console.log(JSON.stringify(results, null, 2));
}

async function cmdWaitLogin(pairsRaw, smsProfile, timeoutSec) {
  const pairs = parsePairs(pairsRaw);
  if (!pairs.length || !smsProfile) throw new Error("need pairs and --sms");
  const pending = pairs.map((p) => ({ ...p, done: false }));
  const results = [];
  const deadline = Date.now() + Number(timeoutSec || 420) * 1000;
  while (Date.now() < deadline && pending.some((p) => !p.done)) {
    let codes = {};
    try {
      codes = await readSmsCodes(smsProfile);
    } catch (e) {
      console.error("[wait-login] read sms failed:", String(e.message || e));
    }
    const ready = pending.filter((p) => !p.done && codes[p.phone]);
    if (ready.length) {
      const res = await Promise.all(ready.map((p) => loginCodeFor(p.profile, codes[p.phone]).then((r) => ({ ...r, phone: p.phone })).catch((e) => ({ profile: p.profile, phone: p.phone, error: String(e.message || e) }))));
      for (const r of res) {
        const p = pending.find((x) => x.phone === r.phone);
        if (p) p.done = true;
        results.push(r);
        console.log("[wait-login]", JSON.stringify(r));
      }
    }
    if (pending.some((p) => !p.done)) await sleep(8_000);
  }
  const notDone = pending.filter((p) => !p.done).map((p) => ({ phone: p.phone, status: "未收到验证码（超时）" }));
  console.log(JSON.stringify({ results, notDone }, null, 2));
}

async function cmdWarmupAll(pairsRaw, seconds) {
  const pairs = parsePairs(pairsRaw);
  const out = [];
  for (const p of pairs) {
    const r = await warmupFor(p.profile, seconds || 12).catch((e) => ({ profile: p.profile, error: String(e.message || e) }));
    out.push(r);
    console.log("[warmup]", JSON.stringify(r));
  }
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const pairs = args[1];
  if (cmd === "request-codes") {
    await cmdRequestCodes(pairs);
  } else if (cmd === "wait-login") {
    const smsIdx = args.indexOf("--sms");
    const sms = smsIdx >= 0 ? args[smsIdx + 1] : "";
    const timeoutIdx = args.indexOf("--timeout");
    const timeout = timeoutIdx >= 0 ? args[timeoutIdx + 1] : 420;
    await cmdWaitLogin(pairs, sms, timeout);
  } else if (cmd === "warmup-all") {
    await cmdWarmupAll(pairs, args[2]);
  } else {
    throw new Error("Usage: request-codes <pairs> | wait-login <pairs> --sms <heroProfileId> [--timeout s] | warmup-all <pairs> [s]");
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
