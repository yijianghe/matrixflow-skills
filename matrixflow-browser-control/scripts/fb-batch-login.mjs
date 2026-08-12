#!/usr/bin/env node
/**
 * 批量 Facebook 登录：读账号映射 JSON，3 并发调用 fb-login.mjs。
 * 用法: node fb-batch-login.mjs <accounts.json> [--concurrency 3]
 * 输出: 每行 "<窗口名>\t<profileId>\t<账号>\t<JSON结果>"
 */
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const accountsFile = process.argv[2];
const concurrency = Number(process.argv.find((a, i) => process.argv[i - 1] === "--concurrency") || 3);
const withLogout = process.argv.includes("--logout");
if (!accountsFile) {
  console.error("用法: fb-batch-login.mjs <accounts.json> [--concurrency 3]");
  process.exit(1);
}

const accounts = JSON.parse(readFileSync(accountsFile, "utf8"));
const loginScript = join(__dirname, "fb-login.mjs");
const logoutScript = join(__dirname, "fb-logout.mjs");
const outFile = process.env.FB_LOGIN_RESULTS || join(dirname(accountsFile), "fb-login-results.jsonl");

function runCommand(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    const timer = setTimeout(() => {
      child.kill();
      resolve("TIMEOUT");
    }, 60_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve("SPAWN_ERROR");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
  });
}

function runOne(entry) {
  return new Promise((resolve) => {
    (async () => {
      try {
        if (withLogout) {
          await runCommand(logoutScript, [entry.id]);
          await new Promise((r) => setTimeout(r, 2500));
        }
        const result = await runCommand(loginScript, [entry.id, entry.a, entry.p]);
        resolve({ entry, result });
      } catch (error) {
        resolve({ entry, result: "ERROR " + (error instanceof Error ? error.message : String(error)) });
      }
    })();
  });
}

let index = 0;
async function worker() {
  while (index < accounts.length) {
    const entry = accounts[index];
    index += 1;
    const { result } = await runOne(entry);
    const line = `${entry.w}\t${entry.id}\t${entry.a}\t${result}`;
    appendFileSync(outFile, line + "\n", "utf8");
    console.log(line);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, () => worker()));
