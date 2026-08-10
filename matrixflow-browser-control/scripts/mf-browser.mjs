#!/usr/bin/env node
/**
 * MatrixFlow Browser Control CLI (speed-optimized)
 *
 * Drives the MatrixFlow antidetect browser windows through its local HTTP API
 * and Chrome DevTools Protocol (CDP). Requires Node.js >= 22 (built-in fetch
 * and WebSocket; no npm dependencies).
 *
 * Speed design:
 * - Connects DIRECTLY to the page-level DevTools websocket (from /json/list),
 *   skipping browser-level attach round-trips.
 * - `navigate` polls `document.readyState` instead of sleeping a fixed time.
 * - `open` waits until the window is CDP-ready before returning.
 * - `run` executes a batch of steps over ONE connection (no per-step process
 *   startup / reconnect), which is the fastest way to do multi-step tasks.
 *
 * Usage:
 *   node mf-browser.mjs status
 *   node mf-browser.mjs list
 *   node mf-browser.mjs open <profileId|name> [url ...]
 *   node mf-browser.mjs close <profileId|name>
 *   node mf-browser.mjs pages <profileId|name>
 *   node mf-browser.mjs navigate <profileId|name> <url>
 *   node mf-browser.mjs title <profileId|name>
 *   node mf-browser.mjs text <profileId|name> [maxChars]
 *   node mf-browser.mjs eval <profileId|name> '<javascript>'   (or '-' + stdin)
 *   node mf-browser.mjs screenshot <profileId|name> <file.png>
 *   node mf-browser.mjs click <profileId|name> <cssSelector>
 *   node mf-browser.mjs type <profileId|name> <cssSelector> <text>
 *   node mf-browser.mjs scroll <profileId|name> [deltaY]
 *   node mf-browser.mjs run <profileId|name> '<steps-json>'     (or '-' + stdin)
 *
 * run steps (executed in one connection, in order):
 *   {"op":"navigate","url":"...","waitReady":true}
 *   {"op":"wait","ms":1000} | {"op":"waitReady","timeout":15000}
 *   {"op":"eval","js":"..."}
 *   {"op":"click","selector":"..."} | {"op":"type","selector":"...","text":"..."}
 *   {"op":"scroll","deltaY":500} | {"op":"text","max":2000} | {"op":"title":true}
 *   {"op":"screenshot","path":"..."}
 *
 * Environment:
 *   MF_LOCAL_API         local API base (default http://127.0.0.1:19527)
 *   MF_LOCAL_API_TOKEN   token override (default read from userData)
 *   MF_USER_DATA         userData root override
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..");
const DEFAULT_PORT = 19527;
const CLOUD_API_BASE = "https://browser.lingjingxia.com/api/v1";
const SKILL_VERSION = "2026-08-10.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 新账号没有任何环境时的默认指纹模板：避免“必须先手动建一个环境”的卡点
const DEFAULT_FINGERPRINT = {
  os: "Windows 10",
  fonts: [
    "Arial", "Arial Black", "Calibri", "Cambria", "Comic Sans MS", "Consolas",
    "Courier New", "Georgia", "Impact", "Lucida Console", "Microsoft YaHei",
    "Segoe UI", "SimSun", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
  ],
  webGL: { mode: "noise", vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0)" },
  canvas: { mode: "noise", noiseSeed: 609607 },
  screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1.25 },
  webRTC: { mode: "proxy" },
  language: "zh-CN",
  platform: "Win32",
  timezone: "Asia/Shanghai",
  languages: ["zh-CN", "zh", "en"],
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  doNotTrack: false,
  geolocation: { mode: "disabled" },
  audioContext: "noise-609607",
  deviceMemory: 8,
  browserVersion: "130.0.0.0",
  hardwareConcurrency: 8,
};

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
    const detail = json?.error?.message || res.statusText;
    const hint =
      res.status === 401
        ? "（本地 API 未授权：请打开 MatrixFlow 客户端，进入“设置 → API 文档”开启本地 API，并把 Token 写入 userData/local-api-token.txt 或用环境变量 MF_LOCAL_API_TOKEN）"
        : "";
    throw new Error(`API ${method} ${pathname} -> ${res.status}: ${detail}${hint}`);
  }
  return json;
}

// 判断客户端是否在运行：任何 HTTP 状态码都说明客户端在运行；
// 只有网络层错误才算“未运行”。兼容不同版本的本地接口（有的版本没有 info 接口）。
async function probeAppRunning() {
  try {
    await api("/api/v1/profiles");
    return { running: true, status: 200 };
  } catch (e) {
    const m = String(e.message).match(/-> (\d{3}):/);
    if (m) return { running: true, status: Number(m[1]) };
    return { running: false, status: 0 };
  }
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

async function resolveProfileId(profile, { allowOffline = false } = {}) {
  const running = await api("/api/v1/profiles/running");
  const runningList = running.data || [];
  const byId = runningList.find((p) => p.profileId === profile);
  if (byId) return byId.profileId;
  let fullList = [];
  try {
    const full = await api("/api/v1/profiles");
    fullList = full.data || [];
  } catch {}
  const fullById = fullList.find((p) => p.id === profile);
  if (fullById) return fullById.id;
  const fullByName = fullList.find((p) => p.name === profile);
  if (fullByName) return fullByName.id;
  if (allowOffline) {
    // 本地列表接口有 100 条上限：新窗口可能不在列表里，但打开/关闭接口
    // 支持直接按 profileId 操作。此处按 ID 特征透传，交给目标接口校验。
    if (/^[A-Za-z0-9_-]{10,}$/.test(profile)) return profile;
    throw new Error(`Profile not found: ${profile}`);
  }
  throw new Error(`Profile not found (running): ${profile}. Open it first or use an exact id.`);
}

function parseProfileSpec(spec) {
  const at = String(spec || "").lastIndexOf("@");
  if (at > 0) {
    return { profile: spec.slice(0, at), selector: spec.slice(at + 1) };
  }
  return { profile: spec, selector: "" };
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
  return {
    ws,
    send,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function findPageTarget(port, selector) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`CDP /json/list failed (${res.status})`);
  const targets = await res.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page");
  const nonInternal = pages.filter((t) => !/browser-start/.test(t.url || ""));
  let page = null;
  if (selector) {
    const index = Number.parseInt(selector, 10);
    if (Number.isFinite(index)) {
      page = pages[index] || null;
    } else {
      page =
        pages.find((t) => (t.url || "").includes(selector)) ||
        pages.find((t) => (t.title || "").includes(selector)) ||
        null;
    }
  }
  if (!page) {
    page = nonInternal[0] || pages[0] || null;
  }
  if (!page) throw new Error(`No page target on port ${port}`);
  return page;
}

async function connectPage(profileSpec) {
  const { profile, selector } = parseProfileSpec(profileSpec);
  let profileDir = findProfileDir(profile);
  if (!profileDir) {
    const id = await resolveProfileId(profile);
    profileDir = findProfileDir(id);
  }
  if (!profileDir) {
    throw new Error(`Profile ${profile} has no DevToolsActivePort. Is it running?`);
  }
  const port = readPort(profileDir);
  const page = await findPageTarget(port, selector);
  if (!page.webSocketDebuggerUrl) {
    throw new Error(`Page target has no webSocketDebuggerUrl: ${page.url}`);
  }
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  // 把目标标签页激活为窗口的活动标签页，确保操作落在用户当前看到的页面上
  await cdp.send("Page.bringToFront").catch(() => void 0);
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evalInPage(cdp, "document.readyState");
      if (state === "complete") return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

/* ---------------- single commands ---------------- */

async function cmdStatus() {
  const probe = await probeAppRunning();
  const info = {
    version: SKILL_VERSION,
    node: process.version,
    baseUrl: baseUrl(),
    token: resolveToken() ? "present" : "missing",
    appRunning: probe.running,
    appHttpStatus: probe.status || undefined,
    userData: resolveUserDataRoot(),
    skillDir: SKILL_DIR,
  };
  console.log(JSON.stringify(info, null, 2));
}

async function cmdList() {
  const running = await api("/api/v1/profiles/running");
  console.log(JSON.stringify(running.data || [], null, 2));
}

async function cmdOpen(args) {
  const profile = args[0];
  if (!profile) throw new Error("Usage: open <profileId|name> [url ...]");
  const id = await resolveProfileId(profile, { allowOffline: true });
  const postLaunchUrls = args.slice(1).filter(Boolean);
  const result = await api(`/api/v1/profiles/${encodeURIComponent(id)}/open`, {
    method: "POST",
    body: postLaunchUrls.length ? { postLaunchUrls } : {},
  });
  // 等待窗口 CDP 就绪（最多 25 秒），避免调用方再盲目 sleep
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const dir = findProfileDir(id);
    if (dir) {
      try {
        const port = readPort(dir);
        await findPageTarget(port, "");
        break;
      } catch {}
    }
    await sleep(300);
  }
  console.log(JSON.stringify({ ok: true, profileId: id, status: result.data?.status }, null, 2));
}

async function cmdClose(profile) {
  const id = await resolveProfileId(profile, { allowOffline: true });
  const result = await api(`/api/v1/profiles/${encodeURIComponent(id)}/close`, { method: "POST" });
  console.log(JSON.stringify({ ok: true, profileId: id, status: result.data?.status }, null, 2));
}

async function cmdCreate(args) {
  let count = 1;
  let platform = "CUSTOM";
  let prefix = "";
  let proxySpec = "";
  const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count") count = Number.parseInt(args[++i], 10) || 1;
    else if (args[i] === "--platform") platform = args[++i] || "CUSTOM";
    else if (args[i] === "--prefix") prefix = args[++i] || "";
    else if (args[i] === "--proxy") proxySpec = args[++i] || "";
    else names.push(args[i]);
  }
  const full = await api("/api/v1/profiles");
  const items = full.data?.items || full.data || [];
  if (full.meta?.source === "running-only" || items.length === 0) {
    if (full.meta?.source === "running-only") {
      throw new Error(
        "无法新建环境：MatrixFlow 客户端未登录（或云端账号不可用）。请先打开客户端登录账号，再重试 create；可先运行 doctor 自检确认。"
      );
    }
    // 新账号没有环境：直接用内置默认指纹创建，不再要求手动建模板
    console.warn(
      "[create] 当前账号没有任何环境，使用内置默认指纹模板自动创建（新账号无需手动建模板）。"
    );
  }
  const tpl = items[0]?.fingerprint ?? DEFAULT_FINGERPRINT;
  if (!tpl) {
    throw new Error(
      "没有可用指纹模板：请先在 MatrixFlow 客户端里手动创建一个环境（当前列表来自云端但缺少指纹数据）。"
    );
  }
  const usedNames = new Set(items.map((p) => p.name));
  // 显式传入多个名称时全部创建（不按 --count 截断）；--count 只用于自动命名模式
  let namesList = names.length ? [...names] : [];
  if (namesList.length === 0) {
    if (prefix) {
      for (let i = 1; i <= count; i++) namesList.push(prefix + i);
    } else {
      let maxNum = 0;
      for (const p of items) {
        const n = Number(p.name);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
      for (let i = 1; i <= count; i++) {
        let cand = String(maxNum + i);
        let k = 1;
        while (usedNames.has(cand)) {
          cand = String(maxNum + i + k);
          k += 1;
        }
        namesList.push(cand);
      }
    }
  }
  // 同名保护：避免出现两个同名窗口（会造成混淆，之前出现过）
  const dup = namesList.find((n) => usedNames.has(n));
  if (dup) {
    throw new Error(
      `已存在同名环境「${dup}」：为避免混淆请换一个名称，或先用 delete 删除旧环境再创建。`
    );
  }
  let proxyId = "";
  if (proxySpec) {
    proxyId = await createCloudProxy(proxySpec);
  }
  const results = [];
  for (const name of namesList) {
    const created = await createProfile({
      name,
      platform,
      fingerprint: JSON.parse(JSON.stringify(tpl)),
      ...(proxyId ? { proxyId } : {})
    });
    results.push({ name, ok: true, id: created?.id, proxyId: proxyId || undefined });
  }
  console.log(JSON.stringify(results, null, 2));
}

async function createCloudProxy(spec) {
  const parts = String(spec || "").split(":");
  if (parts.length < 2) throw new Error("代理格式应为 host:port[:username:password]");
  const host = parts[0];
  const port = Number.parseInt(parts[1], 10);
  if (!host || !Number.isFinite(port) || port <= 0) throw new Error(`代理格式无效: ${spec}`);
  const username = parts.length >= 4 ? parts[2] : "";
  const password = parts.length >= 4 ? parts.slice(3).join(":") : "";
  const type = /^socks5:\/\//i.test(host)
    ? "SOCKS5"
    : /^https:\/\//i.test(host)
      ? "HTTPS"
      : /^http:\/\//i.test(host)
        ? "HTTP"
        : "SOCKS5";
  const cleanHost = host.replace(/^(socks5|http|https):\/\//i, "");
  const token = await resolveCloudToken();
  if (!token) throw new Error("无法读取云端登录令牌，请先在 MatrixFlow 客户端登录");
  const res = await fetch("https://browser.lingjingxia.com/api/v1/proxies", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type, host: cleanHost, port, username, password }),
    signal: AbortSignal.timeout(30_000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(`创建代理失败: ${json?.error?.message || res.statusText}`);
  }
  return json.data.id;
}

async function resolveCloudToken() {
  if (process.platform !== "win32") return "";
  const require = createRequire(import.meta.url);
  const candidates = [
    join(SKILL_DIR, "node_modules", "keytar"),
    join(process.env.LOCALAPPDATA || "", "@matrixflow", "desktop", "node_modules", "keytar"),
    join(dirname(process.execPath), "resources", "app", "node_modules", "keytar")
  ];
  for (const p of candidates) {
    try {
      const keytar = require(p);
      const v = await keytar.getPassword("MatrixFlow", "matrixflow-auth:accessToken");
      if (v) return v;
    } catch {}
  }
  // 本机没有 keytar 时，直接用 PowerShell 读取 Windows 凭据管理器里的 MatrixFlow 登录令牌
  return readCloudTokenViaPowerShell();
}

// 新建环境：优先走本地接口；部分客户端版本本地接口不支持新建，
// 自动回退到云端接口（需要客户端已登录）。
async function createProfile(body) {
  try {
    const r = await api("/api/v1/profiles", { method: "POST", body });
    return r.data;
  } catch (err) {
    const cloudToken = await resolveCloudToken();
    if (!cloudToken) {
      throw new Error(
        `本地接口不支持新建环境（客户端版本限制），且无法读取云端登录令牌：${err.message}`
      );
    }
    const res = await fetch(`${CLOUD_API_BASE}/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cloudToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`云端新建环境失败 ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).data;
  }
}

// 删除环境：优先走本地接口；本地不支持时自动回退到云端接口。
async function deleteProfile(id) {
  try {
    const r = await api(`/api/v1/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.data;
  } catch (err) {
    const cloudToken = await resolveCloudToken();
    if (!cloudToken) {
      throw new Error(
        `本地接口不支持删除环境（客户端版本限制），且无法读取云端登录令牌：${err.message}`
      );
    }
    const res = await fetch(`${CLOUD_API_BASE}/profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cloudToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`云端删除环境失败 ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).data;
  }
}

function readCloudTokenViaPowerShell() {
  if (process.platform !== "win32") return "";
  try {
    const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MfCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public int Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string TargetName, int Type, int Flags, out IntPtr Credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr Buffer);
}
'@;
$ptr = [IntPtr]::Zero;
$ok = [MfCred]::CredRead('MatrixFlow/matrixflow-auth:accessToken', 1, 0, [ref]$ptr);
if (-not $ok) { exit 0 }
try {
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][MfCred+CREDENTIAL]);
  if ($cred.CredentialBlobSize -gt 0) {
    $blob = New-Object byte[] $cred.CredentialBlobSize;
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize);
    $cands = @(
      [System.Text.Encoding]::UTF8.GetString($blob),
      [System.Text.Encoding]::Unicode.GetString($blob)
    );
    foreach ($secret in $cands) {
      if ($secret -match '^[\x20-\x7E]+$' -and $secret.Length -ge 8) {
        Write-Output ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($secret)));
        break;
      }
    }
  }
} finally { [MfCred]::CredFree($ptr) }
`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    });
    if (r.status === 0 && r.stdout) {
      const b64 = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      if (b64) {
        const v = Buffer.from(b64, "base64").toString("utf8").trim();
        if (v) return v;
      }
    }
  } catch {}
  return "";
}

async function cmdDelete(profile) {
  const id = await resolveProfileId(profile, { allowOffline: true });
  const data = await deleteProfile(id);
  console.log(JSON.stringify({ ok: true, profileId: id, data }, null, 2));
}

async function cmdOpenBatch(csv) {
  const ids = String(csv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("Usage: open-batch <id1,id2,...> (并发打开，默认 3 个一批)");
  const results = [];
  const concurrency = 3;
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (p) => {
        try {
          const id = await resolveProfileId(p, { allowOffline: true });
          const r = await api(`/api/v1/profiles/${encodeURIComponent(id)}/open`, { method: "POST", body: {} });
          results.push({ profile: p, ok: true, status: r.data?.status });
        } catch (error) {
          results.push({ profile: p, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })
    );
  }
  console.log(JSON.stringify(results, null, 2));
}

// 上传本地文件到页面 file input（绕过 Windows 文件选择框），用于视频/图片上传
// 用法: upload <id|name[@tab]> <file1> [file2 ...]（多文件一次注入）
async function cmdUpload(profileSpec, ...files) {
  if (!files.length) throw new Error("用法: upload <profileId> <file...>");
  const { cdp } = await connectPage(profileSpec);
  try {
    const doc = await cdp.send("DOM.getDocument");
    const node = await cdp.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!node || !node.nodeId) throw new Error("页面没有 file input（请先进入上传页面）");
    await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files });
    console.log(JSON.stringify({ ok: true, files }));
  } finally {
    cdp.close();
  }
}

async function cmdAutomaOpen(args) {
  const workflowId = args[0];
  let profileId = "";
  let workflowName = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--profile") profileId = args[++i] || "";
    else if (args[i] === "--name") workflowName = args[++i] || "";
  }
  if (!workflowId) throw new Error("Usage: automa-open <workflowId> [--profile <id>] [--name <name>]");
  if (profileId) {
    profileId = await resolveProfileId(profileId, { allowOffline: true });
  }
  const r = await api("/api/v1/matrixflow/automa/open", {
    method: "POST",
    body: { workflowId, profileId, workflowName }
  });
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdWorkflowCreate(workflowId, name) {
  if (!workflowId) throw new Error("Usage: workflow-create <workflowId> [name]");
  const r = await api("/api/v1/matrixflow/workflows/init", {
    method: "POST",
    body: { workflowId, name: name || "新建工作流" }
  });
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdWorkflowList() {
  const r = await api("/api/v1/matrixflow/workflows");
  const list = (r.data || []).map((w) => ({
    id: w.id,
    name: w.name,
    nodes: w.nodes ?? (w.workflowJson?.drawflow?.nodes?.length ?? 0),
    edges: w.edges ?? (w.workflowJson?.drawflow?.edges?.length ?? 0),
    updatedAt: w.updatedAt
  }));
  console.log(JSON.stringify(list, null, 2));
}

async function cmdPages(profile) {
  const { profile: profileId } = parseProfileSpec(profile);
  let profileDir = findProfileDir(profileId);
  if (!profileDir) {
    const id = await resolveProfileId(profileId);
    profileDir = findProfileDir(id);
  }
  if (!profileDir) throw new Error(`Profile ${profileId} has no DevToolsActivePort. Is it running?`);
  const port = readPort(profileDir);
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  const targets = await res.json();
  console.log(
    JSON.stringify(
      (Array.isArray(targets) ? targets : [])
        .filter((t) => t.type === "page")
        .map((p, i) => ({ index: i, url: p.url, title: p.title })),
      null,
      2
    )
  );
}

async function cmdNavigate(profile, url) {
  if (!url) throw new Error("Usage: navigate <profile> <url>");
  const { cdp } = await connectPage(profile);
  try {
    await cdp.send("Page.navigate", { url });
    await waitReady(cdp, 20_000);
    const state = await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})");
    console.log(state);
  } finally {
    cdp.close();
  }
}

async function cmdTitle(profile) {
  const { cdp } = await connectPage(profile);
  try {
    console.log(await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})"));
  } finally {
    cdp.close();
  }
}

async function cmdText(profile, maxChars) {
  const { cdp } = await connectPage(profile);
  try {
    const limit = Number.parseInt(maxChars || "8000", 10);
    const text = await evalInPage(
      cdp,
      `(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return JSON.stringify({text: t.slice(0, ${limit}), length: t.length}); })()`
    );
    console.log(text);
  } finally {
    cdp.close();
  }
}

async function cmdEval(profile, expression) {
  if (!expression || expression === "-") {
    expression = await readStdin();
  }
  if (expression && expression.startsWith("@")) {
    // @<file>：从 UTF-8 文件读取 JS，避免管道/命令行编码问题（推荐中文脚本用）
    expression = readFileSync(expression.slice(1), "utf8");
  }
  if (!expression) throw new Error("Usage: eval <profile> '<javascript>'  (or pipe JS via stdin with '-')");
  const { cdp } = await connectPage(profile);
  try {
    const value = await evalInPage(cdp, expression);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdScreenshot(profile, output) {
  if (!output) throw new Error("Usage: screenshot <profile> <output.png>");
  const { cdp } = await connectPage(profile);
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!shot.data) throw new Error("Screenshot returned no data");
    const buf = Buffer.from(shot.data, "base64");
    writeFileSync(output, buf);
    console.log(JSON.stringify({ ok: true, file: output, bytes: buf.length }));
  } finally {
    cdp.close();
  }
}

async function cmdClick(profile, selector) {
  if (!selector || selector === "-") {
    selector = await readStdin();
  }
  if (!selector) throw new Error("Usage: click <profile> <cssSelector>  (or pipe selector via stdin with '-')");
  const { cdp } = await connectPage(profile);
  try {
    const rect = await evalInPage(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`
    );
    if (!rect) throw new Error(`Selector not found: ${selector}`);
    const { x, y } = JSON.parse(rect);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    console.log(JSON.stringify({ ok: true, selector, x, y }));
  } finally {
    cdp.close();
  }
}

async function cmdType(profile, selector, text) {
  if (!selector || selector === "-") {
    selector = await readStdin();
  }
  if (!selector) throw new Error("Usage: type <profile> <cssSelector> <text>");
  const { cdp } = await connectPage(profile);
  try {
    const focused = await evalInPage(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`
    );
    if (!focused) throw new Error(`Selector not found: ${selector}`);
    await cdp.send("Input.insertText", { text: String(text) });
    console.log(JSON.stringify({ ok: true, selector, inserted: String(text).length }));
  } finally {
    cdp.close();
  }
}

async function cmdScroll(profile, deltaY) {
  const { cdp } = await connectPage(profile);
  try {
    const amount = Number.parseInt(deltaY || "500", 10);
    await evalInPage(cdp, `window.scrollBy(0, ${amount}); 'ok'`);
    console.log(JSON.stringify({ ok: true, deltaY: amount }));
  } finally {
    cdp.close();
  }
}

/* ---------------- run: batch steps over one connection ---------------- */

async function cmdRun(profile, stepsJson) {
  if (!stepsJson || stepsJson === "-") {
    stepsJson = await readStdin();
  }
  const steps = JSON.parse(stepsJson);
  if (!Array.isArray(steps)) throw new Error("run steps must be a JSON array");
  const { cdp } = await connectPage(profile);
  const results = [];
  try {
    for (const step of steps) {
      const started = Date.now();
      let value;
      switch (step.op) {
        case "navigate": {
          await cdp.send("Page.navigate", { url: step.url });
          if (step.waitReady !== false) await waitReady(cdp, step.timeout || 20_000);
          value = await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})");
          break;
        }
        case "wait":
          await sleep(Number(step.ms) || 500);
          value = "ok";
          break;
        case "waitRandom": {
          const min = Number(step.min) || 300;
          const max = Number(step.max) || 1200;
          const ms = Math.floor(min + Math.random() * Math.max(0, max - min));
          await sleep(ms);
          value = ms;
          break;
        }
        case "waitReady":
          value = await waitReady(cdp, step.timeout || 20_000);
          break;
        case "eval":
          value = await evalInPage(cdp, step.js);
          break;
        case "click": {
          const rect = await evalInPage(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`
          );
          if (!rect) throw new Error(`Selector not found: ${step.selector}`);
          const { x, y } = JSON.parse(rect);
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          value = { x, y };
          break;
        }
        case "type": {
          const focused = await evalInPage(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (!el) return false; el.focus(); return true; })()`
          );
          if (!focused) throw new Error(`Selector not found: ${step.selector}`);
          await cdp.send("Input.insertText", { text: String(step.text) });
          value = "typed";
          break;
        }
        case "scroll":
          await evalInPage(cdp, `window.scrollBy(0, ${Number(step.deltaY) || 500}); 'ok'`);
          value = "ok";
          break;
        case "text": {
          const limit = Number(step.max) || 8000;
          value = await evalInPage(
            cdp,
            `(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return JSON.stringify({text: t.slice(0, ${limit}), length: t.length}); })()`
          );
          break;
        }
        case "title":
          value = await evalInPage(cdp, "JSON.stringify({url: location.href, title: document.title})");
          break;
        case "screenshot": {
          const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          const buf = Buffer.from(shot.data || "", "base64");
          writeFileSync(step.path, buf);
          value = { file: step.path, bytes: buf.length };
          break;
        }
        default:
          throw new Error(`Unknown run op: ${step.op}`);
      }
      results.push({ op: step.op, ms: Date.now() - started, value });
    }
  } finally {
    cdp.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

/* ---------------- environment doctor ---------------- */

async function cmdDoctor() {
  const lines = [];
  const ok = (x) => `[PASS] ${x}`;
  const warn = (x) => `[WARN] ${x}`;
  const fail = (x) => `[FAIL] ${x}`;
  const note = (x) => `[INFO] ${x}`;
  const info = {};

  // 1. Node.js 版本
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  info.node = process.version;
  lines.push(note(`技能版本：${SKILL_VERSION}（最新版已内置全部兼容修复，自检全绿后无需修改脚本）`));
  lines.push(
    major >= 22
      ? ok(`Node.js ${process.version}（满足 >=22 要求）`)
      : fail(`Node.js ${process.version} 过低：请安装 Node.js 22+（https://nodejs.org）`)
  );

  // 2. MatrixFlow 客户端是否运行
  info.baseUrl = baseUrl();
  const probe = await probeAppRunning();
  info.appRunning = probe.running;
  if (probe.running) {
    lines.push(
      probe.status === 401
        ? warn(
            `MatrixFlow 客户端正在运行，但本地 API 未授权（401）：请打开客户端“设置 → API 文档”核对 Token 是否正确。`
          )
        : ok(`MatrixFlow 客户端正在运行（${baseUrl()}）`)
    );
  } else {
    lines.push(
      fail(
        `MatrixFlow 客户端未运行或本地 API 不可达（${baseUrl()}）：请先打开 MatrixFlow 应用，并确认“设置 → API”已开启。`
      )
    );
  }

  // 3. 本地 API Token
  const token = resolveToken();
  info.token = token ? "present" : "missing";
  if (!token) {
    lines.push(
      warn(
        "本地 API Token 未配置：部分接口可能返回 401。请在 MatrixFlow 设置 → API 文档中开启本地 API，并把 Token 写入 userData/local-api-token.txt，或用环境变量 MF_LOCAL_API_TOKEN。"
      )
    );
  } else if (token.startsWith("mf_live_") || token.length < 20 || !/^[A-Za-z0-9-]{20,}$/.test(token)) {
    lines.push(
      warn(
        `本地 API Token 格式可疑（${token.slice(0, 12)}...）：当前版本本地 API Token 是 36 位 UUID（形如 201537c0-xxxx-xxxx-xxxx-xxxxxxxxxxxx），不是 mf_live_ 开头的云端/会话 Token。请重新到 MatrixFlow 设置 → API 文档 复制真正的本地 API Token。`
      )
    );
  } else {
    lines.push(ok("本地 API Token 已配置（local-api-token.txt 或 MF_LOCAL_API_TOKEN）"));
  }

  // 4. 环境列表 & 云端登录状态
  let profileCount = 0;
  let runningCount = 0;
  let cloudSource = false;
  try {
    const full = await api("/api/v1/profiles");
    const items = full.data || [];
    profileCount = items.length;
    cloudSource = full.meta?.source !== "running-only";
    lines.push(
      cloudSource
        ? ok(`云端账号已登录，环境列表来自云端（共 ${profileCount} 个环境）`)
        : warn(
            "云端账号未登录或不可用（当前只能看到运行中的窗口）。新建/删除环境都需要登录：请打开 MatrixFlow 客户端登录账号后重试。"
          )
    );
    if (cloudSource && profileCount === 0) {
      lines.push(
        warn(
          "当前账号还没有任何环境：无需手动建模板，直接执行 create 会使用内置默认指纹自动创建窗口。"
        )
      );
    }
  } catch (e) {
    lines.push(warn(`读取环境列表失败：${e.message}`));
  }
  try {
    const running = await api("/api/v1/profiles/running");
    runningCount = (running.data || []).length;
    lines.push(
      runningCount > 0
        ? ok(`当前有 ${runningCount} 个窗口在运行`)
        : note("当前没有窗口在运行（打开窗口用 open <窗口ID|名称>）")
    );
  } catch {}
  info.profileCount = profileCount;
  info.runningCount = runningCount;
  info.cloudSource = cloudSource;

  // 5. 云端登录令牌（绑定代理创建环境需要）
  const cloudToken = await resolveCloudToken();
  info.cloudToken = cloudToken ? "present" : "missing";
  lines.push(
    cloudToken
      ? ok("云端登录令牌可读取（create --proxy 可用）")
      : warn(
          "云端登录令牌未找到：新建/删除/绑代理需要客户端已登录，Windows 凭据管理器中应有 MatrixFlow 登录记录。如果确认已登录仍显示未找到，请用管理员身份重新打开终端再运行 doctor（读取系统凭据需要权限）。"
        )
  );

  // 6. 指纹模板
  if (profileCount === 0) {
    lines.push(
      warn(
        "当前没有任何环境：无需手动建模板，直接执行 create 会使用内置默认指纹自动创建窗口。"
      )
    );
  }

  // 7. 内置兼容修复是否齐全（防止把旧版/被改坏的脚本当最新版用）
  try {
    const selfSrc = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const builtins = {
      "运行检测兼容不同版本(probeAppRunning)": /async function probeAppRunning/.test(selfSrc),
      "新建云端自动回退(createProfile)": /async function createProfile\(body\)/.test(selfSrc),
      "删除云端自动回退(deleteProfile)": /async function deleteProfile\(id\)/.test(selfSrc),
      "多名称批量创建": /names\.length \? \[\.\.\.names\]/.test(selfSrc),
    };
    const missing = Object.entries(builtins)
      .filter(([, present]) => !present)
      .map(([k]) => k);
    lines.push(
      missing.length === 0
        ? ok("内置兼容修复齐全：无需手动修补脚本，直接用")
        : warn(`检测到缺少内置修复：${missing.join("、")}。请从 GitHub 重新下载最新版技能再使用。`)
    );
  } catch {}

  console.log([...lines, "", "环境信息:", JSON.stringify(info, null, 2)].join("\n"));
}

/* ---------------- main ---------------- */

async function main() {
  if (typeof WebSocket === "undefined") {
    throw new Error("This skill requires Node.js >= 22 (built-in WebSocket).");
  }
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(
      [
        "MatrixFlow Browser Control (speed-optimized)",
        "Commands:",
        "  status                                    show app/token/userData status",
        "  doctor                                    full environment self-check (new machine first!)",
        "  list                                      list running environments (windows)",
        "  open <profileId|name> [url ...]            open an environment (waits until CDP-ready)",
        "  open-batch <id1,id2,...>                   open many environments concurrently (3 at a time)",
        "  create <name...> [--count N] [--prefix P]  create new environments (fingerprint cloned from first)",
        "  create <name> --proxy host:port[:user:pass] create environment bound to a proxy (SOCKS5 default)",
        "  delete <profileId|name>                    delete an environment",
        "  close <profileId|name>                     close an environment",
        "  automa-open <workflowId> [--profile <id>]  open the Automa designer for a workflow",
        "  workflow-create <workflowId> [name]        create a new Automa workflow",
        "  workflow-list                              list workflows",
        "  pages <profileId|name>                     list page tabs of a running environment",
        "  navigate <profileId|name> <url>            navigate active page (waits for load)",
        "  title <profileId|name>                     show active page url + title",
        "  text <profileId|name> [maxChars]           extract visible text (default 8000)",
        "  eval <profileId|name> '<js>'               run JS in the page (or '-' + stdin)",
        "  screenshot <profileId|name> <file.png>     save a page screenshot",
        "  click <profileId|name> <cssSelector>       click element center (auto scrolls into view)",
        "  type <profileId|name> <cssSelector> <t>    focus element and insert text",
        "  scroll <profileId|name> [deltaY]           scroll page (default 500)",
        "  run <profileId|name> '<steps-json>'        batch steps in ONE connection (or '-' + stdin)",
        "",
        "Pin a tab: use profileId@<url-substring> (preferred) or profileId@<index>.",
      ].join("\n")
    );
    return;
  }
  switch (command) {
    case "status": return await cmdStatus();
    case "doctor": return await cmdDoctor();
    case "list": return await cmdList();
    case "open": return await cmdOpen(args);
    case "open-batch": return await cmdOpenBatch(args[0]);
    case "upload": return await cmdUpload(args[0], ...args.slice(1));
    case "create": return await cmdCreate(args);
    case "delete": return await cmdDelete(args[0]);
    case "close": return await cmdClose(args[0]);
    case "automa-open": return await cmdAutomaOpen(args);
    case "workflow-create": return await cmdWorkflowCreate(args[0], args[1]);
    case "workflow-list": return await cmdWorkflowList();
    case "pages": return await cmdPages(args[0]);
    case "navigate": return await cmdNavigate(args[0], args[1]);
    case "title": return await cmdTitle(args[0]);
    case "text": return await cmdText(args[0], args[1]);
    case "eval": return await cmdEval(args[0], args[1]);
    case "screenshot": return await cmdScreenshot(args[0], args[1]);
    case "click": return await cmdClick(args[0], args[1]);
    case "type": return await cmdType(args[0], args[1], args[2]);
    case "scroll": return await cmdScroll(args[0], args[1]);
    case "run": return await cmdRun(args[0], args[1]);
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`[mf-browser] ${error instanceof Error ? error.message : String(error)}`);
  setTimeout(() => process.exit(1), 120);
});
