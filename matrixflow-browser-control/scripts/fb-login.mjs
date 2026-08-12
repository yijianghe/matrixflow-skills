#!/usr/bin/env node
/**
 * Facebook 自动登录：用账号+密码登录当前窗口。
 * 用法: node fb-login.mjs <profileId> <账号> <密码>
 * 输出: {"ok":bool,"state":"success|wrong|checkpoint|locked|already|other","message":"...","url":"...","title":"..."}
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const profileSpec = process.argv[2];
const account = process.argv[3];
const password = process.argv[4];
if (!profileSpec || !account || !password) {
  console.error("用法: fb-login.mjs <profileId> <账号> <密码>");
  process.exit(1);
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

function findProfileDir(profileId) {
  const root = resolveUserDataRoot();
  const profilesRoot = join(root, "Profiles");
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

async function findPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CDP /json/list failed (${res.status})`);
  const targets = await res.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page");
  const nonInternal = pages.filter((t) => !/browser-start/.test(t.url || ""));
  const page = nonInternal[0] || pages[0] || null;
  if (!page) throw new Error(`No page target on port ${port}`);
  return page;
}

async function connectPage(profileSpec2) {
  const { profile } = (() => {
    const at = String(profileSpec2 || "").lastIndexOf("@");
    return at > 0 ? { profile: profileSpec2.slice(0, at), selector: profileSpec2.slice(at + 1) } : { profile: profileSpec2, selector: "" };
  })();
  let profileDir = findProfileDir(profile);
  if (!profileDir) throw new Error(`Profile ${profile} has no DevToolsActivePort. Is it running?`);
  const port = readPort(profileDir);
  const page = await findPageTarget(port);
  if (!page.webSocketDebuggerUrl) throw new Error(`Page target has no webSocketDebuggerUrl: ${page.url}`);
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => undefined);
  return { cdp, page, port };
}

async function evalInPage(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`Page JS error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

async function waitReady(cdp, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await evalInPage(cdp, "document.readyState");
      if (state === "complete") return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
const { cdp } = await connectPage(profileSpec);

try {
  await cdp.send("Page.navigate", { url: "https://www.facebook.com/login" });
  await waitReady(cdp, 25_000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2000));

  const pre = await evalInPage(
    cdp,
    `(() => {
      const url = location.href || '';
      const hasForm = !!document.querySelector('input[name="email"]') && !!document.querySelector('input[name="pass"]');
      return JSON.stringify({ url: url.slice(0, 100), hasForm });
    })()`,
  );
  const preState = JSON.parse(pre);
  if (!preState.hasForm && !preState.url.includes("/login")) {
    const st = await evalInPage(
      cdp,
      `(() => {
        const title = document.title || '';
        const lower = location.href.toLowerCase();
        if (lower.includes('/checkpoint') || title.includes('确认你的身份') || title.includes('Checkpoint')) return 'checkpoint';
        if (title.includes('你的账号已被锁定') || title.includes('暂时无法使用')) return 'locked';
        return 'already';
      })()`,
    );
    if (st === "checkpoint") {
      console.log(JSON.stringify({ ok: false, state: "checkpoint", message: "需要身份/设备验证", url: preState.url, title: "" }));
    } else if (st === "locked") {
      console.log(JSON.stringify({ ok: false, state: "locked", message: "账号被锁定/暂时无法使用", url: preState.url, title: "" }));
    } else {
      console.log(JSON.stringify({ ok: true, state: "already", message: "窗口已登录（无登录表单）", url: preState.url, title: "" }));
    }
    process.exit(0);
  }

  const fill = await evalInPage(
    cdp,
    `(() => {
      const email = document.querySelector('input[name="email"]');
      const pass = document.querySelector('input[name="pass"]');
      if (!email || !pass) return 'no-form';
      const set = (el, v) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(email, '${esc(account)}');
      set(pass, '${esc(password)}');
      return 'filled';
    })()`,
  );
  if (fill !== "filled") {
    console.log(JSON.stringify({ ok: false, state: "other", message: "未找到登录表单: " + fill, url: "", title: "" }));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 800));

  const clicked = await evalInPage(
    cdp,
    `(() => {
      const btn = document.querySelector(
        'button[name="login"], button[type="submit"], input[type="submit"], #loginbutton, button[data-testid="royal_login_button"]'
      );
      if (btn) {
        btn.click();
        return 'clicked';
      }
      const form = document.querySelector('#loginform') || document.querySelector('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return 'form-submitted';
      }
      return 'no-button';
    })()`,
  );
  if (clicked !== "clicked" && clicked !== "form-submitted") {
    console.log(JSON.stringify({ ok: false, state: "other", message: "未找到登录按钮: " + clicked, url: "", title: "" }));
    process.exit(0);
  }

  let result = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await evalInPage(
      cdp,
      `(() => {
        const url = location.href || '';
        const lower = url.toLowerCase();
        const title = document.title || '';
        const bodyText = (document.body ? document.body.innerText : '').slice(0, 4000);
        if (lower.includes('/checkpoint') || title.includes('确认你的身份') || title.includes('Checkpoint') || title.includes('Security Check')) {
          return JSON.stringify({ state: 'checkpoint', url: url.slice(0, 120), title: title.slice(0, 60), text: '' });
        }
        if (title.includes('你的账号已被锁定') || title.includes('暂时无法使用') || title.includes('Account Temporarily Unavailable')) {
          return JSON.stringify({ state: 'locked', url: url.slice(0, 120), title: title.slice(0, 60), text: '' });
        }
        if (/密码不正确|密码错误|wrong password|incorrect password|您输入的电子邮件或手机号未与任何账号关联|no account|doesn't match/i.test(bodyText) || document.querySelector('#loginform ._9ay7')) {
          return JSON.stringify({ state: 'wrong', url: url.slice(0, 120), title: title.slice(0, 60), text: bodyText.slice(0, 160) });
        }
        if (!lower.includes('/login') && !lower.includes('login.php')) {
          const feed = !!document.querySelector('div[role="feed"]') || !!document.querySelector('[data-testid="current_account_switcher"]');
          if (feed || title.includes('首页') || title === 'Facebook') {
            return JSON.stringify({ state: 'success', url: url.slice(0, 120), title: title.slice(0, 60), text: '' });
          }
        }
        return null;
      })()`,
    );
    if (st) {
      result = JSON.parse(st);
      break;
    }
  }

  if (!result) result = { state: "timeout", url: "", title: "", text: "" };
  const ok = result.state === "success" || result.state === "already";
  console.log(
    JSON.stringify({
      ok,
      state: result.state,
      message:
        result.state === "success"
          ? "登录成功"
          : result.state === "wrong"
            ? "账号或密码错误"
            : result.state === "checkpoint"
              ? "需要身份/设备验证"
              : result.state === "locked"
                ? "账号被锁定"
                : result.state === "timeout"
                  ? "登录结果未知（超时）"
                  : "其他",
      url: result.url,
      title: result.title,
      text: result.text,
    }),
  );
} finally {
  cdp.close();
}
