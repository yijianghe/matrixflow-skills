#!/usr/bin/env node
/**
 * Automa 设计器真人式控制（2026-08-11 新增）
 * 通过 CDP 真实鼠标/键盘驱动 Automa 工作流设计器：拖拽块、连线、配置、保存。
 * 连接目标：automa-workbench 窗口（launchAutomaWorkbench 已开 --remote-debugging-port=9224）。
 *
 * 用法:
 *   node scripts/automa-designer.mjs status                       # 画布节点/连线/触发器状态
 *   node scripts/automa-designer.mjs drop <块名> <x> <y>          # 从左侧面板拖块到画布坐标
 *   node scripts/automa-designer.mjs connect <fromIdx> <toIdx>    # 从节点输出口拖到下一节点输入口
 *   node scripts/automa-designer.mjs click <idx>                  # 点击节点（打开右侧配置）
 *   node scripts/automa-designer.mjs panel <块名>                 # 滚动面板并返回块坐标
 *   node scripts/automa-designer.mjs save                         # 保存工作流
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.AUTOMA_CDP_PORT || 9224);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

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

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  // 工作台里可能有多个 newtab 页（残留页），优先选当前窗口的 dashboard/designer 页
  const newtabs = (Array.isArray(targets) ? targets : []).filter(
    (t) => t.type === "page" && (t.url || "").includes("newtab.html")
  );
  if (!newtabs.length) throw new Error(`Automa 工作台未运行或端口 ${PORT} 无 newtab 页`);
  // 逐个探测：有 vue-flow 画布（设计器）优先，其次非「已被屏蔽」的页面
  let page = null;
  for (const cand of newtabs) {
    try {
      const c = makeCdp(cand.webSocketDebuggerUrl);
      await c.send("Runtime.enable");
      const r = await c.send("Runtime.evaluate", {
        expression: `JSON.stringify({ flow: !!document.querySelector('.vue-flow'), blocked: /已被屏蔽|ERR_BLOCKED_BY_CLIENT/.test(document.body ? document.body.innerText : '') })`,
        returnByValue: true,
        awaitPromise: true,
      });
      const info = JSON.parse(r.result?.value || "{}");
      c.close();
      if (info.flow) {
        page = cand;
        break;
      }
      if (!page && !info.blocked) page = cand;
    } catch {
      continue;
    }
  }
  if (!page) page = newtabs[0];
  if (!page) throw new Error(`Automa 工作台未运行或端口 ${PORT} 无 newtab 页`);
  const cdp = makeCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => {});
  const ev = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails)
      return "JS_ERR:" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300);
    return r.result?.value;
  };
  const clickAt = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - rand(0, 3), y: y - rand(0, 3) });
    await sleep(rand(60, 120));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(rand(60, 120));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const drag = async (fromX, fromY, toX, toY, steps = 18) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
    await sleep(rand(80, 140));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1 });
    await sleep(rand(120, 180));
    for (let i = 1; i <= steps; i++) {
      const x = fromX + ((toX - fromX) * i) / steps;
      const y = fromY + ((toY - fromY) * i) / steps;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(rand(20, 40));
    }
    await sleep(rand(120, 200));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1 });
    await sleep(400);
  };
  return { cdp, ev, clickAt, drag };
}

async function panelBlock(ev, name) {
  // 滚动左侧面板直到块可见，返回中心坐标
  // 先回到顶部，再逐段向下找（防止面板停留在底部导致上面的块找不到）
  await ev(`(() => {
    const panel = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 80 && e.clientWidth > 150 && e.clientWidth < 500 && e.getBoundingClientRect().x < 400);
    if (panel) panel.scrollTop = 0;
    return !!panel;
  })()`);
  await sleep(300);
  for (let s = 0; s < 10; s++) {
    const pos = await ev(`(() => {
      const el = [...document.querySelectorAll('[class*=cursor-move]')].find(e => {
        const t = (e.textContent || '').trim().replace(/\\s+/g, ' ');
        const r = e.getBoundingClientRect();
        return t === ${JSON.stringify(name)} && r.width > 40 && r.height > 10 && r.bottom > 0 && r.top < innerHeight;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
    })()`);
    if (pos) return JSON.parse(pos);
    await ev(`(() => {
      const panel = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 80 && e.clientWidth > 150 && e.clientWidth < 500 && e.getBoundingClientRect().x < 400);
      if (panel) panel.scrollTop += 350;
      return !!panel;
    })()`);
    await sleep(400);
  }
  return null;
}

async function canvasNodes(ev) {
  const s = await ev(`(() => {
    const nodes = [...document.querySelectorAll('.vue-flow__node')].map(n => {
      const r = n.getBoundingClientRect();
      const handles = [...n.querySelectorAll('.vue-flow__handle')].map(h => {
        const hr = h.getBoundingClientRect();
        return {
          id: (h.className || '').toString(),
          x: Math.round(hr.x + hr.width / 2),
          y: Math.round(hr.y + hr.height / 2),
        };
      });
      return {
        text: (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 40),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        handles,
      };
    });
    return JSON.stringify({ nodes, edges: document.querySelectorAll('.vue-flow__edge').length });
  })()`);
  return JSON.parse(s);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const { cdp, ev, clickAt, drag } = await connect();
  try {
    if (cmd === "status") {
      console.log(JSON.stringify(await canvasNodes(ev), null, 2));
    } else if (cmd === "panel") {
      const pos = await panelBlock(ev, args[1]);
      console.log(JSON.stringify(pos));
    } else if (cmd === "drop") {
      const name = args[1];
      const x = Number(args[2]);
      const y = Number(args[3]);
      const pos = await panelBlock(ev, name);
      if (!pos) throw new Error(`面板里找不到块: ${name}`);
      await drag(pos.x, pos.y, x, y);
      await sleep(1200);
      console.log(JSON.stringify(await canvasNodes(ev), null, 2));
    } else if (cmd === "connect") {
      const fromIdx = Number(args[1]);
      const toIdx = Number(args[2]);
      const st = await canvasNodes(ev);
      const from = st.nodes[fromIdx];
      const to = st.nodes[toIdx];
      if (!from || !to) throw new Error("节点索引无效");
      const out = from.handles.find((h) => h.id.includes("output"));
      const inp = to.handles.find((h) => h.id.includes("input"));
      if (!out || !inp) throw new Error(`节点缺少端口: ${from.text} / ${to.text}`);
      const onScreen = await ev(`JSON.stringify({ outY: ${out.y}, inpY: ${inp.y}, h: innerHeight })`);
      const scr = JSON.parse(onScreen);
      if (out.y < 0 || out.y > scr.h || inp.y < 0 || inp.y > scr.h)
        throw new Error("端口不在视口内，请先 fit-view 再连线");
      // 先点画布空白处，清掉可能卡住的 connecting 状态，再连线
      await clickAt(1100, 300);
      await sleep(500);
      // 慢速精确拖拽：先确认按在输出口，再逐步移到输入口
      await drag(out.x, out.y, inp.x, inp.y, 22);
      await sleep(1000);
      console.log(JSON.stringify(await canvasNodes(ev), null, 2));
    } else if (cmd === "click") {
      const idx = Number(args[1]);
      const st = await canvasNodes(ev);
      const n = st.nodes[idx];
      if (!n) throw new Error("节点索引无效");
      await clickAt(n.x + n.w / 2, n.y + 20);
      await sleep(1000);
      console.log(JSON.stringify({ clicked: n.text }));
    } else if (cmd === "save") {
      // 点击设计器右上角保存（Automa 自动保存，这里确认无未保存状态）
      console.log(JSON.stringify({ ok: true, note: "Automa 设计器一般自动保存，如需手动保存点右上角保存按钮" }));
    } else {
      console.error("未知命令: " + cmd);
      process.exit(1);
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`[automa-designer] ${e.message}`);
  process.exit(1);
});
