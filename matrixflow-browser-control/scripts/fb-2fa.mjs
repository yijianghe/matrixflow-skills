#!/usr/bin/env node
/**
 * Facebook 2FA/验证码自动提交：
 * 登录后若停留在 two_step_verification / challengepicker / codesubmit，
 * 自动选择「短信」方式并等待验证码，提交后确认登录成功。
 *
 * 验证码来源（按顺序）：
 *  1) 命令行参数：node fb-2fa.mjs <profileId> <code>
 *  2) 文件：<cwd>/fb-codes/<profileId>.txt（内容为 6 位验证码）
 *     轮询该文件，最多等待 --wait 秒（默认 600）
 *
 * 用法: node fb-2fa.mjs <profileId> [code] [--wait 600]
 */
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const profileSpec = process.argv[2];
const codeArg = process.argv.find((a, i) => i > 2 && process.argv[i - 1] !== "--wait" && !a.startsWith("--") && /^\d{6}$/.test(a)) || "";
const waitSeconds = Number(process.argv.find((a, i) => process.argv[i - 1] === "--wait") || 600);
if (!profileSpec) {
  console.error("用法: fb-2fa.mjs <profileId> [code] [--wait 600]");
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
        if (entry.name === profileId && existsSync(join(full, "DevToolsActivePort"))) return full;
        stack.push(full);
      }
    }
  }
  return null;
}

const profileDir = findProfileDir(profileSpec);
if (!profileDir) {
  console.error(`Profile ${profileSpec} has no DevToolsActivePort. Is it running?`);
  process.exit(1);
}
const [port] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page =
  (Array.isArray(list) ? list : []).filter((t) => t.type === "page").find((t) => !/browser-start/.test(t.url || "")) ||
  (Array.isArray(list) ? list : []).find((t) => t.type === "page");
if (!page) {
  console.error("No page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("CDP connect failed"));
});
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
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalInPage(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result?.value;
}

const codeDir = join(process.cwd(), "fb-codes");
function readCodeFile() {
  try {
    const p = join(codeDir, `${profileSpec}.txt`);
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8").trim();
      if (/^\d{6}$/.test(raw)) return raw;
    }
  } catch {}
  return "";
}

async function ensureSmsOption() {
  const txt = await evalInPage("(document.body ? document.body.innerText : '').slice(0, 2000)");
  const url = await evalInPage("location.href").catch(() => "");
  if (/challengepicker/.test(String(url)) || /选择身份验证方式/.test(txt)) {
    const r = await evalInPage(`(() => {
      const el = Array.from(document.querySelectorAll("div[role=button],a,button,label,span"))
        .find((e) => /^短信$|短信|Text me|SMS/i.test((e.innerText || "").trim()));
      if (el) { el.click(); return 'clicked-sms'; }
      return 'sms-not-found';
    })()`);
    await new Promise((r) => setTimeout(r, 1200));
    const cont = await evalInPage(`(() => {
      const el = Array.from(document.querySelectorAll("div[role=button],a,button"))
        .find((e) => /^继续$|^Continue$/.test((e.innerText || "").trim()));
      if (el) { el.click(); return 'clicked-continue'; }
      return 'continue-not-found';
    })()`);
    return { sms: r, cont };
  }
  return { sms: "not-challengepicker", cont: "" };
}

try {
  await send("Runtime.enable");
  await send("Page.bringToFront").catch(() => undefined);
  const url = await evalInPage("location.href");
  const lower = String(url).toLowerCase();
  if (!/two_step|checkpoint|auth_platform|codesubmit|challenge/i.test(lower)) {
    console.log(JSON.stringify({ ok: false, state: "not-2fa", url: String(url).slice(0, 100), message: "当前页面不是验证页，先执行 fb-login 再调用" }));
    process.exit(0);
  }

  const picked = await ensureSmsOption();
  let code = codeArg;
  if (!code) {
    mkdirSync(codeDir, { recursive: true });
    const deadline = Date.now() + waitSeconds * 1000;
    console.log(JSON.stringify({ ok: false, state: "waiting-code", message: `等待验证码（放入 ${join(codeDir, profileSpec + ".txt")} 或传参）`, url: String(url).slice(0, 100) }));
    while (Date.now() < deadline) {
      code = readCodeFile();
      if (code) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!code) {
    console.log(JSON.stringify({ ok: false, state: "timeout", message: "等待验证码超时", picked }));
    process.exit(0);
  }

  const typed = await evalInPage(`(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const target = inputs.find((i) => {
      const t = (i.getAttribute("autocomplete") || i.name || i.id || i.getAttribute("aria-label") || "");
      return /one-time|code|token|otp/i.test(t);
    }) || inputs.find((i) => i.type === "tel" || i.type === "text" || i.inputMode === "numeric" || i.getAttribute("maxlength") === "6");
    if (!target) return 'no-input';
    const proto = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(target, "${code}");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return 'typed';
  })()`);
  await new Promise((r) => setTimeout(r, 800));

  const submitted = await evalInPage(`(() => {
    const btn = Array.from(document.querySelectorAll("div[role=button],button"))
      .find((e) => /^继续$|^提交$|^Continue$|^Submit$|^确认$/.test((e.innerText || "").trim()));
    if (btn) { btn.click(); return 'clicked'; }
    const form = document.querySelector("form");
    if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'form-submitted'; }
    return 'no-button';
  })()`);

  let finalState = "unknown";
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await evalInPage(`(() => {
      const u = location.href.toLowerCase();
      const t = document.title || "";
      const feed = !!document.querySelector("div[role=feed]") || !!document.querySelector("[data-testid=current_account_switcher]");
      if (u.includes("checkpoint") || t.includes("确认你的身份") || t.includes("Checkpoint")) return "checkpoint";
      if (u.includes("two_step") || u.includes("auth_platform") || u.includes("codesubmit") || u.includes("challenge")) return "still-2fa";
      if (feed || (u.startsWith("https://www.facebook.com/") && !u.includes("login") && t.includes("Facebook"))) return "success";
      return "unknown";
    })()`);
    if (st === "success" || st === "checkpoint" || st === "still-2fa") {
      finalState = st;
      if (st !== "still-2fa") break;
      if (i > 20) break;
    }
  }
  console.log(
    JSON.stringify({
      ok: finalState === "success",
      state: finalState,
      message:
        finalState === "success"
          ? "验证通过，已登录"
          : finalState === "checkpoint"
            ? "验证后仍进入 checkpoint，需进一步人工处理"
            : finalState === "still-2fa"
              ? "仍在验证页（可能验证码错误或方式不匹配）"
              : "结果未知",
      typed,
      submitted,
      picked,
      url: await evalInPage("location.href").then((u) => String(u).slice(0, 120)),
    }),
  );
} finally {
  ws.close();
}
