#!/usr/bin/env node
/**
 * 批量 Facebook 登录状态检测：读窗口 JSON（[{w,id}]），3 并发调 fb-login-status.mjs。
 * 用法: node fb-batch-status.mjs <windows.json>
 */
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const windowsFile = process.argv[2];
if (!windowsFile) {
  console.error("用法: fb-batch-status.mjs <windows.json>");
  process.exit(1);
}
const windows = JSON.parse(readFileSync(windowsFile, "utf8"));
const statusScript = join(__dirname, "fb-login-status.mjs");
const outFile = process.env.FB_STATUS_RESULTS || join(dirname(windowsFile), "fb-status-results.jsonl");

function runOne(entry) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [statusScript, entry.id], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ entry, result: "TIMEOUT" });
    }, 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ entry, result: "SPAWN_ERROR " + err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ entry, result: stdout.trim() || "EXIT_" + code + " " + stderr.trim().slice(0, 160) });
    });
  });
}

let index = 0;
async function worker() {
  while (index < windows.length) {
    const entry = windows[index];
    index += 1;
    const { result } = await runOne(entry);
    const line = `${entry.w}\t${entry.id}\t${result}`;
    appendFileSync(outFile, line + "\n", "utf8");
    console.log(line);
  }
}

await Promise.all(Array.from({ length: Math.min(3, windows.length) }, () => worker()));
