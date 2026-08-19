#!/usr/bin/env node
/**
 * Facebook 批量并发发帖（2026-08-13）
 * 原则：一次最多 3-5 个窗口（客户电脑配置低），打开→发帖→关闭，再处理下一批。
 * 每个窗口自动分配一篇不同文案，配图自动走产品图目录。
 *
 * 用法:
 *   node scripts/fb-batch-post.mjs <windows.json> <texts-dir> [--concurrency 3] [--max-per-window 2]
 *   windows.json: [{ "w": "脸书8", "id": "..." }, ...]
 *   texts-dir:    含 p1.txt / p2.txt ... 的文案目录
 *   --max-per-window: 每个账号（窗口）一次最多发几篇（默认 2，符合"2-3 个发完关闭"）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const windowsFile = process.argv[2];
const textsDir = process.argv[3];
const concurrency = Number(process.argv.find((a, i) => process.argv[i - 1] === "--concurrency") || 3);
const maxPerWindow = Number(process.argv.find((a, i) => process.argv[i - 1] === "--max-per-window") || 2);
if (!windowsFile || !textsDir) {
  console.error("用法: fb-batch-post.mjs <windows.json> <texts-dir> [--concurrency 3] [--max-per-window 2]");
  process.exit(1);
}

function resolveUserDataRoot() {
  if (process.env.MF_USER_DATA) return process.env.MF_USER_DATA;
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
}

const token = readFileSync(join(resolveUserDataRoot(), "local-api-token.txt"), "utf8").trim();
const apiBase = process.env.MF_LOCAL_API || "http://127.0.0.1:19527";
const windows = JSON.parse(readFileSync(windowsFile, "utf8"));
const textFiles = readdirSync(textsDir).filter((f) => /\.txt$/i.test(f)).sort();
const postScript = join(__dirname, "fb-post.mjs");

async function api(path, method = "POST", body = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-MatrixFlow-Token": token },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return j;
}

async function openWindow(id) {
  const r = await api(`/api/v1/profiles/${id}/open`, "POST", {});
  return r.success === true;
}

async function closeWindow(id) {
  const r = await api(`/api/v1/profiles/${id}/close`, "POST", {});
  return r.success === true;
}

function runPost(profileId, textFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [postScript, profileId, "--text-file", textFile, "--visibility", "public"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, out: stdout, err: "TIMEOUT" }); }, 240_000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out: stdout, err: String(e.message) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && /发布成功/.test(stdout);
      resolve({ ok, out: stdout.trim().split("\n").slice(-4).join(" | "), code });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每窗口分配 maxPerWindow 篇不同文案（轮转分配，同一窗口内不重复）
const jobs = windows.map((w, i) => ({
  ...w,
  textFiles: Array.from({ length: Math.min(maxPerWindow, textFiles.length) }, (_, k) =>
    join(textsDir, textFiles[(i * maxPerWindow + k) % textFiles.length])),
}));
const results = [];
let index = 0;

async function worker() {
  while (index < jobs.length) {
    const job = jobs[index];
    index += 1;
    const t0 = Date.now();
    let opened = false;
    try {
      opened = await openWindow(job.id);
      if (!opened) throw new Error("open failed");
      await sleep(4000);
      let done = 0;
      for (const tf of job.textFiles) {
        const t1 = Date.now();
        const r = await runPost(job.id, tf);
        done += r.ok ? 1 : 0;
        results.push({ w: job.w, ok: r.ok, out: r.out, ms: Date.now() - t1 });
        console.log(`[${job.w}] ${r.ok ? "OK" : "FAIL"} ${Math.round((Date.now() - t1) / 1000)}s | ${r.out}`);
        // 同一账号连续发帖要间隔（模拟真人 + 降风控）；失败则停止该窗口
        if (!r.ok) break;
        await sleep(2500 + Math.floor(Math.random() * 2000));
      }
      console.log(`[${job.w}] 本账号完成 ${done}/${job.textFiles.length} 篇`);
    } catch (e) {
      results.push({ w: job.w, ok: false, out: String(e.message), ms: Date.now() - t0 });
      console.log(`[${job.w}] FAIL ${String(e.message)}`);
    } finally {
      try { await closeWindow(job.id); } catch {}
      console.log(`[${job.w}] 窗口已关闭`);
    }
    await sleep(1500);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

const okCount = results.filter((r) => r.ok).length;
console.log("\n=== 完成: " + okCount + "/" + results.length + " 成功 ===");
for (const r of results) console.log(`${r.w}: ${r.ok ? "OK" : "FAIL"} ${r.out}`);
