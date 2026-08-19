#!/usr/bin/env node
/**
 * Facebook 表格驱动自动发帖（不依赖 Automa，2026-08-13 实测）
 *
 * 流程（每行 = 一个窗口 = 一篇帖子）：
 *   读表格 → 打开窗口 → 强制中文 → 打开发布框 → CDP 注入图片+文本 →
 *   设公开（多语言）→ 点发帖 → 验证 → 关闭窗口 → 下一行
 *
 * 用法:
 *   node fb-table-auto.mjs <queue.csv> [--window <profileId>] [--row <N>] [--dry]
 *   --window 覆盖表格里的窗口（测试用）；--row 只跑指定行；--dry 只验证到打开发布框
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const csvFile = process.argv[2];
const overrideWindow = process.argv.find((a, i) => process.argv[i - 1] === "--window") || "";
const onlyRow = Number(process.argv.find((a, i) => process.argv[i - 1] === "--row") || 0);
const dryRun = process.argv.includes("--dry");
if (!csvFile || !existsSync(csvFile)) {
  console.error("用法: node fb-table-auto.mjs <queue.csv> [--window <id>] [--row N] [--dry]");
  process.exit(1);
}

// ---------- 基础 ----------
function resolveUserDataRoot() {
  if (process.env.MF_USER_DATA) return process.env.MF_USER_DATA;
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
}
const token = readFileSync(join(resolveUserDataRoot(), "local-api-token.txt"), "utf8").trim();
const apiBase = process.env.MF_LOCAL_API || "http://127.0.0.1:19527";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

async function api(path, method = "POST", body = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-MatrixFlow-Token": token },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

// ---------- CSV ----------
function parseCSV(text) {
  const rows = [];
  let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field);
      if (cur.some((f) => f.trim() !== "")) rows.push(cur);
      cur = []; field = "";
    } else field += ch;
  }
  if (field !== "" || cur.length) { cur.push(field); if (cur.some((f) => f.trim() !== "")) rows.push(cur); }
  return rows;
}

// ---------- CDP ----------
function findProfileDir(profileId) {
  const root = join(resolveUserDataRoot(), "Profiles");
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
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

async function connectProfile(profileId) {
  const dir = findProfileDir(profileId);
  if (!dir) throw new Error("窗口未运行（无 DevToolsActivePort）");
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0], 10);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  if (!page) throw new Error("窗口里没有 facebook 标签页");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nid = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++nid;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(method + " timeout")); }, 10000);
    pending.set(i, (r) => { clearTimeout(t); res(r); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? null : r.result?.value;
  };
  const jsClick = (x, y) => ev(`(() => {
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: ${Math.round(x)}, clientY: ${Math.round(y)}, button: 0 };
    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(type, opts));
    return true;
  })()`);
  return { ws, send, ev, jsClick, close: () => { try { ws.close(); } catch {} } };
}

const COMPOSER_KEYWORDS = ["分享你的新鲜事", "分享想法", "무슨 생각을", "What's on your mind", "게시물 만들기", "Create Post", "A cosa stai pensando", "Crea post"];

// ---------- 发帖流程 ----------
async function publishOne(profileId, postText, imagePath, { dry = false } = {}) {
  // 0) 确保窗口里有 facebook 标签页（fb-post 需要）
  const dir0 = findProfileDir(profileId);
  if (dir0) {
    const port0 = Number.parseInt(readFileSync(join(dir0, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0], 10);
    const pages0 = (await (await fetch(`http://127.0.0.1:${port0}/json/list`)).json()).filter((t) => t.type === "page");
    const fb0 = pages0.find((t) => /facebook\.com/.test(t.url || ""));
    if (!fb0 && pages0.length) {
      const ws0 = new WebSocket(pages0[0].webSocketDebuggerUrl);
      let i0 = 0; const p0 = new Map();
      ws0.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && p0.has(m.id)) { p0.get(m.id)(m.result); p0.delete(m.id); } };
      await new Promise((r, j) => { ws0.onopen = r; ws0.onerror = j; });
      const s0 = (method, params = {}) => new Promise((res, rej) => { const i = ++i0; const t = setTimeout(() => { p0.delete(i); rej(new Error("timeout")); }, 30000); p0.set(i, (r) => { clearTimeout(t); res(r); }); ws0.send(JSON.stringify({ id: i, method, params })); });
      await s0("Page.navigate", { url: "https://www.facebook.com/" });
      await sleep(10000);
      ws0.close();
    }
  }
  // 2026-08-13：直接调用已验证的 fb-post.mjs 发帖（公开设置/图文同框/多语言均已实测）
  const fbPost = "C:\\Users\\admin\\.codex\\skills\\matrixflow-browser-control\\scripts\\fb-post.mjs";
  const tmp = mkdtempSync(join(tmpdir(), "mf-post-"));
  const textFile = join(tmp, "post.txt");
  writeFileSync(textFile, postText, "utf8");
  const args = [fbPost, profileId, "--text-file", textFile, "--visibility", "public"];
  if (imagePath && existsSync(imagePath)) args.push("--image", imagePath);
  const r = spawnSync(process.execPath, args, { windowsHide: true, encoding: "utf8", timeout: 240000 });
  const out = (r.stdout || "") + (r.stderr || "");
  console.log(out.trim().split("\n").slice(-3).join("\n"));
  const ok = r.status === 0 && /发布成功/.test(out);
  return { ok, step: ok ? "发布成功（fb-post）" : (out.match(/\[fb-post\] [^\n]*/) || ["发布失败"])[0] };
}

// ---------- 主流程 ----------
const rows = parseCSV(readFileSync(csvFile, "utf8"));
const header = rows[0].map((h) => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
let jobs = rows.slice(1)
  .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])))
  .filter((r) => r.window_id && r.post_text && !/^(已发布|成功)$/.test(r.status));
if (onlyRow) jobs = jobs.filter((r) => Number(r.seq) === onlyRow);
console.log(`待发布 ${jobs.length} 行${dryRun ? "（dry 模式：只验证到打开发布框）" : ""}`);

let okCount = 0;
for (const job of jobs) {
  const winId = overrideWindow || job.window_id;
  const t0 = Date.now();
  console.log(`\n[${job.seq}] 打开窗口 ${winId} ...`);
  try {
    const open = await api(`/api/v1/profiles/${winId}/open`, "POST", {});
    if (!open.success) { console.log(`[${job.seq}] 打开失败`); continue; }
    await sleep(12000);
    const r = await publishOne(winId, job.post_text, job.image_path, { dry: dryRun });
    console.log(`[${job.seq}] 结果: ${r.ok ? "OK" : "FAIL"} - ${r.step}（${Math.round((Date.now() - t0) / 1000)}s）`);
    if (r.ok) okCount++;
  } catch (e) {
    console.log(`[${job.seq}] 异常: ${e.message}`);
  } finally {
    try { await api(`/api/v1/profiles/${winId}/close`, "POST", {}); console.log(`[${job.seq}] 窗口已关闭`); } catch {}
    await sleep(2000);
  }
}
console.log(`\n=== 完成: ${okCount}/${jobs.length} 成功 ===`);
