#!/usr/bin/env node
/**
 * Facebook 表格批量发布编排（2026-08-13）
 * 配合 Automa 工作流「facebook-publish.automa.json」使用。
 *
 * 分工：
 *   本脚本（MatrixFlow 侧）：
 *     读表格 → 逐个打开窗口 → CDP 注入行数据(localStorage) →
 *     等 Automa 打开发布框 → CDP 注入图片+文本 → 等 Automa 发完(mf_done) → 关窗 → 下一行
 *   Automa 工作流（窗口内，手动运行一次）：
 *     强制中文界面 → 从 localStorage 读数据 → 打开发布框 → 等内容注入 →
 *     设公开 → 点发帖 → 标记 mf_done
 *
 * 用法: node fb-table-run.mjs <queue.csv> [--timeout 600]
 * 表格列: seq, window_id, post_text, image_path, status(待发布/已发布/失败)
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const csvFile = process.argv[2];
const timeoutSec = Number(process.argv.find((a, i) => process.argv[i - 1] === "--timeout") || 600);
if (!csvFile || !existsSync(csvFile)) {
  console.error("用法: node fb-table-run.mjs <queue.csv> [--timeout 600]");
  process.exit(1);
}

function resolveUserDataRoot() {
  if (process.env.MF_USER_DATA) return process.env.MF_USER_DATA;
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
}

const token = readFileSync(join(resolveUserDataRoot(), "local-api-token.txt"), "utf8").trim();
const apiBase = process.env.MF_LOCAL_API || "http://127.0.0.1:19527";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = "POST", body = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-MatrixFlow-Token": token },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

// ---------- CDP（读窗口调试端口，操作页面） ----------
function findProfileDir(id) {
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
        if (entry.name === id && existsSync(join(full, "DevToolsActivePort"))) return full;
        stack.push(full);
      }
    }
  }
  return null;
}

async function getPageWs(id) {
  const dir = findProfileDir(id);
  if (!dir) return null;
  const port = Number.parseInt(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0], 10);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
  const page = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && /facebook\.com/.test(t.url || ""));
  return page ? { ws: page.webSocketDebuggerUrl, port } : null;
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
    ws.onerror = () => reject(new Error("ws error"));
    ws.onclose = () => reject(new Error("ws closed"));
  });
  async function send(method, params = {}) {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 8000);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { ws, send, close: () => { try { ws.close(); } catch {} } };
}

async function withCdp(id, fn) {
  const p = await getPageWs(id);
  if (!p) return null;
  const cdp = makeCdp(p.ws);
  try {
    await cdp.send("Runtime.enable").catch(() => {});
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function evalInPage(id, expr) {
  return withCdp(id, async (cdp) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? null : r.result?.value;
  });
}

// ---------- CSV 解析 ----------
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

// ---------- 主流程 ----------
const rows = parseCSV(readFileSync(csvFile, "utf8"));
const header = rows[0].map((h) => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const jobs = rows.slice(1)
  .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])))
  .filter((r) => r.window_id && r.post_text && !/^(已发布|成功)$/.test(r.status));

console.log(`待发布 ${jobs.length} 行`);
let okCount = 0;

for (const job of jobs) {
  const t0 = Date.now();
  console.log(`\n[${job.seq}] 打开窗口 ${job.window_id} ...`);
  try {
    const open = await api(`/api/v1/profiles/${job.window_id}/open`, "POST", {});
    if (!open.success) { console.log(`[${job.seq}] 打开失败，跳过`); continue; }
    await sleep(8000);

    // 1) 注入行数据到页面 localStorage（Automa 工作流读取）
    const payload = JSON.stringify({ text: job.post_text, image: job.image_path || "", seq: job.seq });
    await evalInPage(job.window_id, `localStorage.setItem('mf_post', ${JSON.stringify(payload)}); localStorage.setItem('mf_composer_ready','0'); localStorage.setItem('mf_content_ready','0'); localStorage.setItem('mf_done',''); 'injected'`);
    console.log(`[${job.seq}] 数据已注入。请在窗口的 Automa 面板运行工作流「Facebook 表格发帖」`);

    // 2) 等 Automa 打开发布框（composer_ready=1）
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const v = await evalInPage(job.window_id, `localStorage.getItem('mf_composer_ready')`);
      if (v === "1") { ready = true; break; }
      await sleep(1000);
    }
    if (!ready) { console.log(`[${job.seq}] 等待发布框超时（Automa 未运行？）`); continue; }
    console.log(`[${job.seq}] 发布框已打开，注入图片和文本...`);

    // 3) CDP 注入图片（DOM.setFileInputFiles）
    if (job.image_path && existsSync(job.image_path)) {
      const injected = await withCdp(job.window_id, async (cdp) => {
        const doc = await cdp.send("DOM.getDocument", { depth: -1 });
        const q = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type=file][accept*="image"]' });
        if (!q.nodeId) return false;
        await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [job.image_path] });
        return true;
      });
      if (!injected) console.log(`[${job.seq}] 图片注入失败（找不到文件输入框）`);
      await sleep(2500);
    }

    // 4) CDP 输入文本（Input.insertText 到 contenteditable）
    await withCdp(job.window_id, async (cdp) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => { const ce = [...document.querySelectorAll('[role=dialog] div[contenteditable=true]')].filter(e => e.getBoundingClientRect().width > 40).sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height)[0]; if (!ce) return false; ce.focus(); return true; })()`,
        returnByValue: true,
      });
      if (r.result?.value === true) {
        await cdp.send("Input.insertText", { text: job.post_text });
      }
    });
    await sleep(1500);
    await evalInPage(job.window_id, `localStorage.setItem('mf_content_ready','1'); 'ok'`);
    console.log(`[${job.seq}] 图文已注入，等 Automa 发帖...`);

    // 5) 等 Automa 发完（mf_done 有值）
    let done = "";
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const v = await evalInPage(job.window_id, `localStorage.getItem('mf_done')`);
      if (v) { done = v; break; }
      await sleep(5000);
    }
    console.log(`[${job.seq}] mf_done=${done || "超时"}`);
    if (done === "published") okCount++;
  } catch (e) {
    console.log(`[${job.seq}] 异常: ${e.message}`);
  } finally {
    // 6) 关闭窗口
    try { await api(`/api/v1/profiles/${job.window_id}/close`, "POST", {}); console.log(`[${job.seq}] 窗口已关闭`); } catch {}
    await sleep(2000);
  }
}

console.log(`\n=== 完成: ${okCount}/${jobs.length} 发布成功 ===`);
