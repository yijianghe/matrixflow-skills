#!/usr/bin/env node
/**
 * 小红书快速发布脚本（2026-08-05）
 *
 * 默认用平台原生「文字转图片」做封面，每次随机选不同模板；
 * 也支持本地图片（--image / --image-dir，默认从 Downloads / 桌面找）。
 * 全程一条 CDP 连接 + 轮询等待，速度优先。
 *
 * 用法：
 *   node scripts/xhs-publish.mjs <profileId> \
 *     --title "标题（≤20字）" --cover "封面文字" --body "正文（含话题）" \
 *     [--template random|基础|美漫|插图|涂鸦|清新|边框|备忘|简约|光影|手写] \
 *     [--visibility 仅自己可见|公开可见|仅互关好友可见] \
 *     [--image <文件路径> | --image-dir <文件夹>] \
 *     [--draft]        # 只存草稿不发布
 *
 * 说明：
 *   - 正文建议用 --body-file <path> 传入 UTF-8 文本文件（避免命令行引号问题）。
 *   - 本地图片默认目录：C:\Users\admin\Downloads、桌面、ShareX 截图目录。
 *   - 默认可见范围「仅自己可见」（私密），要公开请显式 --visibility 公开可见。
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TITLES = ["基础", "美漫", "插图", "涂鸦", "涂写", "清新", "边框", "备忘", "简约", "光影", "手写", "书摘"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(1, max - min));

function resolveUserDataRoot() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "@matrixflow", "desktop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "@matrixflow", "desktop");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "@matrixflow", "desktop");
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
        if (entry.name === profileId && existsSync(join(full, "DevToolsActivePort"))) return full;
        stack.push(full);
      }
    }
  }
  return null;
}

// ---------- 文案去重（禁止重复发文案） ----------
function historyPath() {
  return join(resolveUserDataRoot(), "xhs-publish-history.json");
}

function loadHistory() {
  try {
    const p = historyPath();
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {}
  return [];
}

function saveHistory(hist) {
  try {
    writeFileSync(historyPath(), JSON.stringify(hist, null, 2), "utf8");
  } catch (e) {
    console.warn("[xhs-publish] 历史记录写入失败：" + e.message);
  }
}

function normalizeText(s) {
  return String(s || "").replace(/[\s#，。！？、,.!?：:；;""''（）()\[\]【】—\-_]/g, "");
}

function ngrams(s, n = 2) {
  const out = new Set();
  const t = normalizeText(s);
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

// 返回与历史重复的记录；无重复返回 null
function findDuplicate(title, body) {
  const hist = loadHistory();
  const tN = normalizeText(title);
  const bG = ngrams(body || "");
  for (const h of hist) {
    if (h.title && normalizeText(h.title) === tN) {
      return { ...h, reason: "标题完全相同" };
    }
    if (h.body && bG.size > 20) {
      const sim = jaccard(bG, ngrams(h.body));
      if (sim > 0.55) return { ...h, reason: `正文相似度 ${sim.toFixed(2)} 过高` };
    }
  }
  return null;
}

function appendHistory(title, body, industry) {
  const hist = loadHistory();
  hist.push({ title, body, date: new Date().toISOString(), industry: industry || "" });
  saveHistory(hist);
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

async function evalInPage(cdp, expression, timeout = 60000) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout });
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(rand(60, 140));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(rand(30, 70));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function scrollThenCenter(cdp, expr) {
  const ok = await evalInPage(cdp, `(() => {
    const el = ${expr};
    if (!el) return false;
    // 手动滚动最近的可滚动祖先使元素居中（scrollIntoView 对深层滚动容器可能失效）
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const s = getComputedStyle(cur);
      if (cur.scrollHeight > cur.clientHeight + 20 && (s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowY === "overlay")) {
        const er = el.getBoundingClientRect();
        const cr = cur.getBoundingClientRect();
        cur.scrollTop = (er.top - cr.top) + cur.scrollTop - cur.clientHeight / 2;
        break;
      }
      cur = cur.parentElement;
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  })()`);
  if (!ok) return null;
  await sleep(400);
  return evalInPage(cdp, `(() => {
    const el = ${expr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return null;
    return { x, y };
  })()`);
}

async function centerOf(cdp, expr) {
  return scrollThenCenter(cdp, expr);
}

// 可靠点击：滚动到目标 → 坐标有效（视口内）即点击；失效则重试
async function clickReliable(cdp, expr, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pos = await scrollThenCenter(cdp, expr);
    if (pos) {
      await clickAt(cdp, pos.x, pos.y);
      return true;
    }
    await sleep(400);
  }
  return false;
}

async function waitFor(cdp, expr, timeoutMs = 30000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evalInPage(cdp, expr);
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

function findLocalImage(imagePath, imageDir) {
  const candidates = [imagePath].filter(Boolean);
  if (imageDir) candidates.push(imageDir);
  const dirs = [join(homedir(), "Downloads"), join(homedir(), "Desktop"), join(homedir(), "Documents", "ShareX", "Screenshots")];
  for (const d of dirs) {
    if (existsSync(d)) candidates.push(d);
  }
  for (const c of candidates) {
    if (!c) continue;
    if (existsSync(c)) {
      if (c.toLowerCase().match(/\.(png|jpe?g|webp)$/)) return c;
      const files = readdirSync(c).filter((f) => f.toLowerCase().match(/\.(png|jpe?g|webp)$/));
      if (files.length) return join(c, files[0]);
    }
  }
  return null;
}

function parseSchedule(str) {
  // 支持: "YYYY-MM-DD HH:mm" / "明天 HH:mm" / "后天 HH:mm" / "HH:mm"（今天）
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const s = String(str).trim();
  let m;
  let dayOffset = 0;
  if (/^明天/.test(s)) {
    dayOffset = 1;
    m = s.match(/(\d{1,2}):(\d{2})$/);
  } else if (/^后天/.test(s)) {
    dayOffset = 2;
    m = s.match(/(\d{1,2}):(\d{2})$/);
  } else {
    m = s.match(/^(\d{4}-\d{2}-\d{2})?[\s]?(\d{1,2}):(\d{2})$/);
  }
  if (!m) return null;
  let d = new Date();
  if (dayOffset > 0) {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  } else if (m[1]) {
    const [y, mo, da] = m[1].split("-").map(Number);
    d = new Date(y, mo - 1, da);
  } else {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const hh = Number(dayOffset > 0 ? m[1] : m[2]);
  const mm = Number(dayOffset > 0 ? m[2] : m[3]);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
  if (target.getTime() < now.getTime() + 60 * 60 * 1000) return null; // 平台要求定时至少1小时后
  return {
    dateStr: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`,
    y: target.getFullYear(),
    mo: target.getMonth() + 1,
    day: target.getDate(),
    hh: pad(hh),
    mm: pad(mm),
  };
}

async function setSchedule(cdp, scheduleStr, stamp) {
  const t = parseSchedule(scheduleStr);
  if (!t) {
    console.error("定时时间不合法：平台要求至少1小时后才能定时发布（格式 YYYY-MM-DD HH:mm / 明天 HH:mm / 后天 HH:mm）");
    return false;
  }
  // 1) 打开定时开关：循环点击直到日期框出现（不管残留状态，总会翻到"开"）
  let dpReady = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const hasDp = await evalInPage(cdp, `!!document.querySelector('.post-time-wrapper .d-datepicker')`);
    if (hasDp) { dpReady = true; break; }
    // 定时发布按钮在页面下方：先把「更多设置」区域滚到内部滚动容器中央
    await evalInPage(cdp, `(() => {
      const sc = document.querySelector('.publish-page');
      const wrap = document.querySelector('.post-time-wrapper');
      if (sc && wrap) {
        const wr = wrap.getBoundingClientRect();
        const sr = sc.getBoundingClientRect();
        sc.scrollTop = (wr.top - sr.top) + sc.scrollTop - sc.clientHeight / 2;
      }
      return 'ok';
    })()`);
    await sleep(400);
    // 必须点滑块（d-switch 40x24），点卡片文字区无效
    await clickReliable(cdp, `document.querySelector('.post-time-wrapper .d-switch, .post-time-wrapper .custom-switch-switch')`);
    await sleep(700);
  }
  stamp("定时开关打开：" + dpReady);
  if (!dpReady) return false;
  // 2) 打开日期时间面板
  const dpClicked = await clickReliable(cdp, `document.querySelector('.post-time-wrapper .d-datepicker')`);
  stamp("定时日期框点击：" + dpClicked);
  if (!dpClicked) return false;
  const panelOpened = await waitFor(cdp, `!!document.querySelector('.d-datepicker-body')`, 5000, 300);
  stamp("定时面板打开：" + !!panelOpened);
  if (!panelOpened) return false;
  // 3) 若目标日期不是今天：先选日期（点日期后面板自动关闭，时间之后再选）
  const nowD = new Date();
  const isToday = t.y === nowD.getFullYear() && t.mo === nowD.getMonth() + 1 && t.day === nowD.getDate();
  if (!isToday) {
    const dayExpr = `[...document.querySelectorAll('.d-datepicker-dates .d-datepicker-cell')].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && (c.textContent || '').trim() === ${JSON.stringify(String(t.day))} && !/disabled/.test(String(c.className || ''));
    })[0]`;
    const dayClicked = await clickReliable(cdp, dayExpr);
    stamp("日期选择：" + dayClicked);
    if (!dayClicked) {
      console.error(`目标日期 ${t.dateStr} 不在当前月份面板，请选择本月内的日期`);
      return false;
    }
    await sleep(500);
    // 面板已关，重开（日期保留）
    await clickReliable(cdp, `document.querySelector('.post-time-wrapper .d-datepicker')`);
    await waitFor(cdp, `!!document.querySelector('.d-datepicker-body')`, 4000, 300);
  }
  // 4-6) 选小时 + 分钟（用 wheel 滚动到容器中央 + 命中验证点击），验证显示值
  const pickTime = async (value, isMinute) => {
    const xCond = isMinute ? "> 1060" : "< 1060";
    for (let i = 0; i < 25; i++) {
      const st = await evalInPage(cdp, `(() => {
        const bar = [...document.querySelectorAll('.d-timepicker-timebar')].find((b) => b.getBoundingClientRect().x ${xCond});
        if (!bar) return null;
        const el = [...bar.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(value)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const br = bar.getBoundingClientRect();
        return JSON.stringify({ top: Math.round(r.top), x: Math.round(r.x + r.width / 2), y: Math.round(r.top + r.height / 2), barTop: Math.round(br.top), barBottom: Math.round(br.bottom), cx: Math.round(br.x + br.width / 2), cy: Math.round(br.y + br.height / 2) });
      })()`);
      if (!st) return false;
      const s = JSON.parse(st);
      const inView = s.top >= s.barTop && s.top <= s.barBottom - 20;
      if (inView) {
        const hitTxt = await evalInPage(cdp, `(() => { const h = document.elementFromPoint(${s.x}, ${s.y}); return h ? (h.textContent || '').trim().slice(0, 6) : ''; })()`);
        if (hitTxt === value) {
          await clickAt(cdp, s.x, s.y);
          return true;
        }
      }
      // 把 wheel 事件直接分发到分钟/小时列容器自身（只滚它，不会误滚外层日期）
      for (const dir of [s.top < s.barTop ? 240 : -240, s.top < s.barTop ? -240 : 240]) {
        await evalInPage(cdp, `(() => {
          const bar = [...document.querySelectorAll('.d-timepicker-timebar')].find((b) => b.getBoundingClientRect().x ${xCond});
          if (!bar) return false;
          const br = bar.getBoundingClientRect();
          bar.dispatchEvent(new WheelEvent('wheel', {
            deltaY: ${dir},
            clientX: br.x + br.width / 2,
            clientY: br.y + br.height / 2,
            bubbles: true,
            cancelable: true,
            view: window
          }));
          return true;
        })()`);
        await sleep(250);
      }
    }
    return false;
  };
  const readVal = () => evalInPage(cdp, `(() => {
    const p = document.querySelector('.d-datepicker-input-filter, .post-time-wrapper .d-datepicker-content, .post-time-wrapper');
    return p ? (p.textContent || '').trim().slice(0, 30) : null;
  })()`);
  const panelOpen = await evalInPage(cdp, `!!document.querySelector('.d-datepicker-body')`);
  if (!panelOpen) {
    await clickReliable(cdp, `document.querySelector('.post-time-wrapper .d-datepicker')`);
    await waitFor(cdp, `!!document.querySelector('.d-datepicker-body')`, 4000, 300);
  }
  await pickTime(t.hh, false);
  await sleep(300);
  await pickTime(t.mm, true);
  await sleep(800);
  const val = await readVal();
  stamp("定时显示：" + val);
  // 分钟选择器在需要滚动时可能点不准：若分钟偏差 ≤3 视为成功，否则警告（仍会定时，分钟用平台默认）
  const m = val ? String(val).match(/(\d{1,2}):(\d{2})$/) : null;
  if (m) {
    const got = Number(m[2]);
    const want = Number(t.mm);
    if (Math.abs(got - want) <= 3) return true;
    console.warn(`[xhs-publish] 定时分钟 ${got} 与目标 ${want} 偏差 >3，已保留平台默认（当前+30分钟）。精确分钟需在发布页人工微调。`);
    return true;
  }
  return !!(val && val.includes(t.dateStr));
}

async function fillForm(cdp, opt, stamp) {
  const hasForm = await evalInPage(cdp, `!!document.querySelector('input[placeholder*="标题"]')`);
  if (!hasForm) {
    const next = await centerOf(cdp, `[...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '下一步')`);
    if (!next) throw new Error("下一步 button not found");
    await clickAt(cdp, next.x, next.y);
    stamp("进入发布表单");
    await waitFor(cdp, `!!document.querySelector('input[placeholder*="标题"]')`, 15000);
  }

  await evalInPage(cdp, `(() => {
    const el = document.querySelector('input[placeholder*="标题"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(opt.title)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await evalInPage(cdp, `(() => {
    const ed = document.querySelector('.tiptap.ProseMirror');
    if (!ed) return 'no-editor';
    ed.focus();
    ed.innerHTML = '';
    document.execCommand('insertText', false, ${JSON.stringify(opt.body)});
    return (ed.textContent || '').slice(0, 40);
  })()`);
  // 关闭正文触发的话题建议浮层（会盖住"更多设置"），点标题输入框失焦
  const titleBox = await scrollThenCenter(cdp, `document.querySelector('input[placeholder*="标题"]')`);
  if (titleBox) {
    await clickAt(cdp, titleBox.x, titleBox.y);
    await sleep(250);
  }
  stamp("标题+正文已填");
  // 话题校验：至少 3 个与内容相关的话题（同城流量需带地域+行业+同行话题）
  const topicCount = await evalInPage(cdp, `(() => {
    const ed = document.querySelector('.tiptap.ProseMirror');
    const t = ed ? (ed.textContent || '') : '';
    return (t.match(/#[^\\s#]+/g) || []).length;
  })()`);
  if (topicCount < 3) {
    throw new Error(`正文话题仅 ${topicCount} 个，必须 ≥3 个且与内容相关才能发布（同城流量带「地域+行业+场景+同行话题」）。请在正文补足话题后重发。`);
  }
  // 无关话题拦截：话题必须与内容相关（地域/行业/场景/痛点），禁止测试类通用词
  const badTopics = await evalInPage(cdp, `(() => {
    const ed = document.querySelector('.tiptap.ProseMirror');
    const t = ed ? (ed.textContent || '') : '';
    const tops = t.match(/#([^\\s#]+)/g) || [];
    return tops.filter((x) => /测试|定时发布|随便|无题|暂无/.test(x));
  })()`);
  if (badTopics && badTopics.length) {
    throw new Error(`正文含与内容无关的话题：${badTopics.join(" ")}。话题必须从标题/正文提炼（地域词+行业词+场景词），请修正后重发。`);
  }

  if (opt.visibility !== "公开可见") {
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      // 先 hover 一下再点击（d-select 有 hover 展开行为）
      const pos = await scrollThenCenter(cdp, `document.querySelector('.permission-card-select')`);
      if (pos) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
        await sleep(500);
      }
      await clickReliable(cdp, `document.querySelector('.permission-card-select')`);
      await sleep(500);
      const o = await waitFor(cdp, `(() => {
        const cands = [...document.querySelectorAll('.group-info .name, [class*="permission"] [class*="option"]')].filter(e => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(opt.visibility)});
        const vis = cands.find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight; });
        if (!vis) return null;
        vis.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = vis.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`, 2500, 250);
      if (!o) continue;
      const { x, y } = JSON.parse(o);
      await clickAt(cdp, x, y);
      for (let i = 0; i < 10; i++) {
        await sleep(200);
        const matched = await evalInPage(cdp, `(() => {
          const p = document.querySelector('.permission-card-select');
          const t = p ? (p.textContent || '').trim() : '';
          return t.includes(${JSON.stringify(opt.visibility)});
        })()`);
        if (matched) { ok = true; break; }
      }
    }
    stamp("可见范围：" + (ok ? opt.visibility : "设置失败！"));
    if (!ok && opt.visibility !== "公开可见") {
      throw new Error("可见范围设置失败，已停止发布（防止误发公开）。请人工检查表单。");
    }
  }

  if (opt.schedule) {
    const ok = await setSchedule(cdp, opt.schedule, stamp);
    stamp("定时发布：" + (ok ? opt.schedule : "设置失败"));
  }

  if (opt.draft) {
    const draftBtn = await evalInPage(cdp, `(() => {
      const cands = [
        ...document.querySelectorAll('button, [role="button"], xhs-draft-btn, [class*="draft"]')
      ].filter((x) => /草稿/.test((x.textContent || '').trim() + ' ' + (x.getAttribute('aria-label') || '')));
      const vis = cands.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight; });
      if (!vis) return null;
      vis.click();
      return 'clicked';
    })()`);
    stamp("已点存草稿：" + (draftBtn || "未找到草稿按钮（表单已保留，可直接人工存/发）"));
    return false;
  } else {
    const pub = await evalInPage(cdp, `(() => {
      const host = document.querySelector('xhs-publish-btn');
      if (!host) return 'no-publish-host';
      const sr = host._sr || host.shadowRoot;
      if (!sr) return 'no-shadow';
      const b = sr.querySelector('button.bg-red');
      if (!b) return 'no-red-btn';
      b.click();
      return 'clicked';
    })()`);
    stamp("发布：" + pub);
    let published = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const u = await evalInPage(cdp, "location.href");
      if (u && u.includes("published=true")) { published = true; break; }
    }
    stamp("发布结果：" + (published ? "成功" : "待确认"));
    return published;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const profileId = args[0];
  if (!profileId) {
    console.error("Usage: xhs-publish.mjs <profileId> --title ... --cover ... --body ... [options]");
    process.exit(1);
  }
  const opt = { template: "random", visibility: "仅自己可见", draft: false, industry: "" };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--title") opt.title = args[++i];
    if (args[i] === "--cover") opt.cover = args[++i];
    if (args[i] === "--body") opt.body = args[++i];
    if (args[i] === "--body-file") opt.body = readFileSync(args[++i], "utf8").trim();
    if (args[i] === "--template") opt.template = args[++i];
    if (args[i] === "--visibility") opt.visibility = args[++i];
    if (args[i] === "--image") opt.image = args[++i];
    if (args[i] === "--image-dir") opt.imageDir = args[++i];
    if (args[i] === "--draft") opt.draft = true;
    if (args[i] === "--schedule") opt.schedule = args[++i];
    if (args[i] === "--industry") opt.industry = args[++i];
  }
  if (!opt.title || !opt.body) {
    console.error("Missing --title or --body/--body-file");
    process.exit(1);
  }
  if (opt.title.length > 20) {
    console.error(`标题 ${opt.title.length} 字 > 20，请缩短`);
    process.exit(1);
  }
  // 文案去重拦截：标题相同或正文相似度过高直接拒绝（用户铁律：永不重复文案）
  const dup = findDuplicate(opt.title, opt.body);
  if (dup) {
    console.error(`文案重复拦截：${dup.reason}。与「${dup.title}」（${dup.date ? dup.date.slice(0, 10) : "历史记录"}）重复，请换角度/换结构写全新文案。`);
    process.exit(1);
  }
  if (opt.template !== "random" && !TITLES.includes(opt.template)) {
    console.warn(`模板名"${opt.template}"不在已知列表，将尝试模糊匹配`);
  }
  if (opt.visibility === "公开可见" && !opt.draft) {
    console.error("公开发布需要显式确认：加 --draft 先看草稿，或确认后手动改脚本");
    process.exit(1);
  }

  const t0 = Date.now();
  const stamp = (label) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

  const profileDir = findProfileDir(String(profileId).split("@")[0]);
  if (!profileDir) throw new Error(`Profile ${profileId} not running`);
  const port = Number.parseInt(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/)[0], 10);
  const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official";

  // 确保发布页存在
  let targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = targets.find((t) => t.type === "page" && t.url.includes("creator.xiaohongshu.com/publish"));
  if (!page) {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = makeCdp(ver.webSocketDebuggerUrl);
    await bws.send("Target.createTarget", { url: PUBLISH_URL });
    bws.close();
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === "page" && t.url.includes("creator.xiaohongshu.com/publish"));
      if (page) break;
    }
  }
  if (!page) throw new Error("Cannot open publish page");
  stamp("发布页就绪");

  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 拦截系统文件选择对话框：即使误点"上传图片"也不会弹出 Windows 窗口
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});

  // 等待页面可交互（模式选择或表单）
  await waitFor(cdp, `!!(/上传图文|上传视频/.test(document.body.innerText || '') || document.querySelector('input[placeholder*="标题"]'))`, 40000);
  await sleep(300);

  // 如果页面停在残留表单（自动保存的旧草稿）→ 先退出重新开始，避免封面/文案不一致
  const alreadyForm = await evalInPage(cdp, `!!document.querySelector('input[placeholder*="标题"]')`);
  if (alreadyForm) {
    stamp("检测到残留表单，先退出重新开始");
    const back = await centerOf(cdp, `document.querySelector('.publish-page-back-btn')`);
    if (back) await clickAt(cdp, back.x, back.y);
    await sleep(1200);
    const confirm = await evalInPage(cdp, `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /放弃|退出|丢弃/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`);
    if (confirm) {
      const c = JSON.parse(confirm);
      await clickAt(cdp, c.x, c.y);
      await sleep(1500);
    }
    await waitFor(cdp, `!!/上传图文|上传视频/.test(document.body.innerText || '')`, 10000);
    stamp("已回到上传模式");
  }

  // 若停在「上传视频」模式 → 切「上传图文」（过滤隐藏副本）
  const mode = await evalInPage(cdp, `(() => {
    const t = document.body.innerText || '';
    if (!/拖拽视频到此|视频大小/.test(t) || document.querySelector('input[placeholder*="标题"]')) return 'ok';
    const leaf = [...document.querySelectorAll('*')].find((e) => {
      if (e.children.length !== 0 || (e.textContent || '').trim() !== '上传图文') return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight;
    });
    if (!leaf) return 'no-switch';
    const r = leaf.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (mode && mode.startsWith("{")) {
    const { x, y } = JSON.parse(mode);
    await clickAt(cdp, x, y);
    stamp("切换到上传图文");
    await sleep(1200);
  }

  if (opt.image || opt.imageDir) {
    // ---------- 本地图片模式 ----------
    const img = findLocalImage(opt.image, opt.imageDir);
    if (!img) throw new Error("No local image found (Downloads/Desktop/ShareX). Use --image <path> to specify.");
    console.log("IMAGE:", img);
    stamp("使用本地图片");
    const entry = await centerOf(cdp, `[...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '上传图片，或写文字生成图片')`);
    if (entry) await clickAt(cdp, entry.x, entry.y);
    await sleep(800);
    // 直接给隐藏 file input 注入文件（不弹对话框）
    const inputFound = await evalInPage(cdp, `!!document.querySelector('input[type="file"]')`);
    if (!inputFound) throw new Error("file input not found");
    const doc = await cdp.send("DOM.getDocument");
    const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
    await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [img] });
    stamp("图片已注入");
    await waitFor(cdp, `[...document.querySelectorAll('img')].some(i => i.getBoundingClientRect().width > 200)`, 30000);
    await sleep(1200);
  } else {
    // ---------- 文字转图片模式 ----------
    const entry = await centerOf(cdp, `[...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '上传图片，或写文字生成图片')`);
    if (!entry) throw new Error("entry not found");
    await clickAt(cdp, entry.x, entry.y);
    // 轮询等面板出现，点「文字配图」（绝不点「上传图片」）
    const textBtn = await waitFor(cdp, `(() => {
      const b = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '文字配图');
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`, 6000, 300);
    if (!textBtn) throw new Error("文字配图 button not found");
    const tb = JSON.parse(textBtn);
    await clickAt(cdp, tb.x, tb.y);
    await sleep(600);

    await evalInPage(cdp, `(() => {
      const ed = document.querySelector('.card-editor-container .ProseMirror');
      if (!ed) return 'no-editor';
      ed.focus();
      ed.innerHTML = '';
      document.execCommand('insertText', false, ${JSON.stringify(opt.cover || opt.title)});
      return ed.textContent;
    })()`);
    await sleep(400);
    const gen = await centerOf(cdp, `document.querySelector('.edit-text-button')`);
    if (!gen) throw new Error("generate button not found");
    await clickAt(cdp, gen.x, gen.y);
    stamp("已点生成图片（同文案走缓存会秒出）");

    const genStart = Date.now();
    let done = false;
    for (let i = 0; i < 180; i++) {
      await sleep(500);
      const st = await evalInPage(cdp, `(() => {
        const big = [...document.querySelectorAll('img')].some(x => x.getBoundingClientRect().width > 200);
        const btn = document.querySelector('.edit-text-button');
        return { big, btn: btn ? (btn.textContent || '').trim() : null };
      })()`);
      if (st && st.big && !st.btn) { done = true; break; }
      if (i > 60 && st && st.big) { done = true; break; }
    }
    if (!done) throw new Error("cover generation timeout");
    stamp(`封面生成完成（${((Date.now() - genStart) / 1000).toFixed(1)}s）`);
    await sleep(700);

    // 选模板：滚到底 → 随机/指定 → 点击后验证选中态（class/aria/预览图），失败重试
    const tplStart = Date.now();
    await evalInPage(cdp, `(() => {
      const first = document.querySelector('.cover-item-container');
      const sc = (() => {
        let cur = first;
        while (cur && cur !== document.body) {
          const s = getComputedStyle(cur);
          if (cur.scrollHeight > cur.clientHeight + 20 && (s.overflowY === 'auto' || s.overflowY === 'scroll')) return cur;
          cur = cur.parentElement;
        }
        return null;
      })();
      (sc || document.querySelector('[class*="cover-list"], [class*="template-list"]') || document.body).scrollTop = 1e6;
      return 'ok';
    })()`);
    await sleep(500);
    const tpl = await evalInPage(cdp, `(() => {
      const want = ${JSON.stringify(opt.template)};
      const items = [...document.querySelectorAll('.cover-item-container')].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight;
      });
      if (!items.length) return null;
      let target;
      if (want !== 'random') {
        target = items.find((c) => {
          const name = c.querySelector('.cover-name');
          return name && (name.textContent || '').trim() === want;
        });
      }
      if (!target) target = items[Math.floor(Math.random() * items.length)];
      const name = target.querySelector('.cover-name');
      const r = target.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), name: name ? (name.textContent || '').trim() : '', id: String(target.className || '').slice(0, 50) });
    })()`);
    if (!tpl) throw new Error("no template items found");
    const t = JSON.parse(tpl);
    const beforeSrc = await evalInPage(cdp, `(() => { const i = [...document.querySelectorAll('img')].find(x => x.getBoundingClientRect().width > 200); return i ? (i.currentSrc || i.src) : ''; })()`);
    let tplOk = false;
    await clickAt(cdp, t.x, t.y);
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      const chk = await evalInPage(cdp, `(() => {
        const items = [...document.querySelectorAll('.cover-item-container')];
        const active = items.filter((c) => /active|selected|checked/i.test(String(c.className || '')));
        if (active.length === 1) {
          const n = active[0].querySelector('.cover-name');
          return n ? (n.textContent || '').trim() : null;
        }
        const src = (() => { const img = [...document.querySelectorAll('img')].find((x) => x.getBoundingClientRect().width > 200); return img ? (img.currentSrc || img.src) : ''; })();
        return src && src !== ${JSON.stringify(beforeSrc)} ? '__src_changed' : null;
      })()`);
      if (chk === t.name || chk === "__src_changed") { tplOk = true; break; }
    }
    if (!tplOk) await clickAt(cdp, t.x, t.y); // 再点一次兜底，不耗时验证
    stamp(`模板：${t.name}${tplOk ? "（已选中）" : "（未能验证，继续）"}，${((Date.now() - tplStart) / 1000).toFixed(1)}s`);
    await sleep(400);
  }

  // 下一步 → 表单 → 填标题正文 → 可见范围 → 发布
  const published = await fillForm(cdp, opt, stamp);
  if (published) {
    appendHistory(opt.title, opt.body, opt.industry);
    stamp("已记录到发布历史（防重复）");
  }

  cdp.close();
  console.log(`TOTAL: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("[xhs-publish]", e.message);
  process.exit(1);
});
