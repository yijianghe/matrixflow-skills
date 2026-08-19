// Cloak 内核兼容输入模块（2026-08-13）
// MatrixFlow v1.15+ 的 CloakBrowser 内核会屏蔽 CDP 合成鼠标 pressed/released
// 与键盘事件（Input.dispatchMouseEvent / Input.dispatchKeyEvent 到不了页面，
// 只有 mouseMoved 和 Input.insertText 正常）。
// 这里统一改用「页面内 JS 合成事件」完成点击和按键，保证 fb-* 脚本全流程可用。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在 (x, y) 处用页面内 JS 合成鼠标事件序列点击。
 * 先发 CDP mouseMoved（真实移动、无副作用），再 dispatch pointer/mouse 事件。
 */
export async function jsClickAt(cdp, ev, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }).catch(() => {});
  await sleep(40 + Math.floor(Math.random() * 60));
  await ev(cdp, `(() => {
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!el) return false;
    const base = { bubbles: true, cancelable: true, view: window, clientX: ${Math.round(x)}, clientY: ${Math.round(y)}, button: 0 };
    const down = { ...base, buttons: 1, pointerId: 1, isPrimary: true, pointerType: "mouse" };
    const up = { ...base, buttons: 0, pointerId: 1, isPrimary: true, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", down));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", up));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", base));
    return true;
  })()`);
  await sleep(40 + Math.floor(Math.random() * 60));
}

/** 页面内合成按键（Escape / Enter），用于关弹窗/换行。 */
export async function jsPressKey(cdp, ev, key) {
  const isEnter = key === "Enter";
  const code = isEnter ? "Enter" : "Escape";
  const vk = isEnter ? 13 : 27;
  await ev(cdp, `(() => {
    const opts = { bubbles: true, cancelable: true, key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, keyCode: ${vk}, which: ${vk} };
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keyup", opts));
    return true;
  })()`);
}
