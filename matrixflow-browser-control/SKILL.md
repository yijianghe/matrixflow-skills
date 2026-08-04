---
name: matrixflow-browser-control
description: '控制 MatrixFlow 指纹浏览器（窗口=环境）：打开/关闭浏览器窗口、浏览网页、点击、输入、滚动、提取文本、执行 JS、截图。当用户要求用 MatrixFlow 浏览器（或某个浏览器窗口/环境）浏览网站、搜索、填表单、采集页面、查看页面或完成网页任务时使用。'
---

# MatrixFlow 浏览器控制技能

通过本地 HTTP API 和 Chrome DevTools 协议（CDP）驱动 MatrixFlow 指纹浏览器的窗口（"环境"）。这是 AI 接管浏览器窗口的完整能力：打开真实浏览器窗口、导航页面、与页面交互、读取内容、截图。

## 前置条件

- MatrixFlow 桌面应用正在运行（如果 `status` 显示 API 不可达，先启动应用）。
- Node.js >= 22（脚本只使用内置的 `fetch` + `WebSocket`，无任何 npm 依赖）。
- 脚本：`scripts/mf-browser.mjs`（用 `node` 运行）。

## 快速开始

```bash
node scripts/mf-browser.mjs status          # 确认应用在运行 + Token 正常
node scripts/mf-browser.mjs list            # 列出运行中的环境（窗口）
node scripts/mf-browser.mjs open <id|name>  # 打开一个环境窗口
node scripts/mf-browser.mjs navigate <id|name> https://example.com
node scripts/mf-browser.mjs text <id|name>
```

先运行 `status`：它会输出 API 地址、应用是否在运行、Token 是否存在。如果应用没在运行，先启动 MatrixFlow，再重新检查。

## 工作流程

1. **确认应用在运行**：`node scripts/mf-browser.mjs status`。如果 `appRunning` 为 false，启动 MatrixFlow 并等待几秒后重试。
2. **选择窗口**：`node scripts/mf-browser.mjs list` 返回运行中的环境。后续所有命令使用其中的精确 `profileId`（或名称）。
3. **如需打开窗口**：`open <id|name> [url ...]` 启动环境，命令会等待 Chromium CDP 就绪后返回，无需再盲目等待。
4. **交互**：导航 → 等待加载 → 读取 `text`/`title` → `click`/`type`/`scroll` → 用 `text` 或 `screenshot` 验证。
5. **收尾**：完成后 `close <id|name>`（可选；用户想保留窗口就不关）。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `status` | 显示应用状态、API 地址、Token、userData 路径 |
| `list` | 列出运行中的环境（profileId、状态、url） |
| `open <id\|name> [url ...]` | 打开环境窗口（可带启动网址），等待就绪后返回 |
| `close <id\|name>` | 关闭环境窗口 |
| `pages <id\|name>` | 列出环境窗口里的所有标签页（带序号） |
| `navigate <id\|name> <url>` | 导航到网址（自动等待页面加载完成） |
| `title <id\|name>` | 显示当前页面 url + title |
| `text <id\|name> [maxChars]` | 提取页面可见文本（默认 8000 字） |
| `eval <id\|name> '<js>'` | 在页面执行 JS 并输出结果（传 `-` 可从 stdin 读，避免引号问题） |
| `screenshot <id\|name> <file.png>` | 保存页面截图 |
| `click <id\|name> <cssSelector>` | 点击元素中心（自动滚动进视口；传 `-` 可从 stdin 读选择器） |
| `type <id\|name> <cssSelector> <text>` | 聚焦元素并输入文字（选择器可传 `-` 从 stdin 读） |
| `scroll <id\|name> [deltaY]` | 滚动页面（默认 500） |
| `run <id\|name> '<steps-json>'` | 一次连接批量执行多步操作（传 `-` 从 stdin 读 JSON） |

## run 批量模式（多步任务最快）

`run` 在**同一条 CDP 连接**里依次执行一串操作，每步只需几毫秒，避免多次启动进程和重连。步骤（JSON 数组）：

- `{"op":"navigate","url":"...","waitReady":true}` — 导航（默认等待加载完成）
- `{"op":"wait","ms":1000}` — 固定等待
- `{"op":"waitRandom","min":300,"max":1200}` — 随机等待（模拟真人节奏）
- `{"op":"waitReady","timeout":15000}` — 等待页面就绪
- `{"op":"eval","js":"..."}` — 执行 JS
- `{"op":"click","selector":"..."}` — 点击（自动滚动进视口）
- `{"op":"type","selector":"...","text":"..."}` — 输入文字
- `{"op":"scroll","deltaY":500}` — 滚动
- `{"op":"text","max":2000}` — 提取文本
- `{"op":"title"}` — 获取 url + title
- `{"op":"screenshot","path":"..."}` — 截图

示例：打开页面 → 等加载 → 点赞 → 验证 → 截图：

```bash
echo '[{"op":"navigate","url":"https://example.com"},{"op":"waitReady"},{"op":"eval","js":"document.title"},{"op":"screenshot","path":"D:\\shot.png"}]' | node scripts/mf-browser.mjs run <id|name> -
```

## 速度设计

- 命令直接连接**页面级** DevTools WebSocket（跳过浏览器级 attach 的往返）。
- `navigate` / `waitReady` 轮询 `document.readyState`，不再固定等待。
- `open` 等窗口 CDP 就绪后才返回。
- `click` 自动把目标滚动到视口中间再点（屏幕外的元素点了没反应）。
- 每次操作前会先激活目标标签页（`Page.bringToFront`），保证操作落在用户当前看到的页面上。
- 多步任务优先用 `run`：一次连接，页面加载后每步几毫秒。

## 真人式浏览

`scripts/human-browse.mjs` 模拟真人浏览信息流：打开每篇笔记、切换图片、滚动评论区、随机人味节奏、给指定笔记点赞。支持“新标签页打开”的网站（跟随新标签→操作→关闭→回到列表）和“同标签跳转”的网站（返回上一页）。

```bash
node scripts/human-browse.mjs <profileSpec> <feedUrl> --notes 5 --like 3
```

- `--notes N` — 浏览几篇笔记（默认 5）
- `--like N` — 给第 N 篇点赞（从 1 开始；0 = 不点赞，默认 0）
- `--shot PATH` — 最终截图保存路径
- 示例：`node scripts/human-browse.mjs cmse…@小红书 https://www.xiaohongshu.com/explore --notes 5 --like 3`

站点注意点：小红书要点击笔记**卡片**（`section.note-item`），而不是卡片里的 `<a>` 锚点（它的矩形是 0，点不到）；笔记详情链接通常带 `xsec_token`，直接重开可能被重定向回列表。

## 规则与提示

- **标识符**：使用 `list` 输出的精确 `profileId`（或名称）。未运行的窗口要先 `open`，CDP 命令需要窗口在运行。
- **多标签页**：一个窗口可能含多个标签。默认操作“第一个非内部页面标签”。标签多时先 `pages` 查看，然后用 `profileId@网址片段`（如 `cmse…@wd=Codex`）锁定标签；**优先用网址片段而不是序号**，因为序号会随标签开关变化。
- **等待**：`navigate` 已自动等待加载完成；如页面内容异步渲染，可再用 `waitReady` 或 `text` 轮询确认。
- **选择器**：标准 CSS 选择器。`click` 用真实 CDP 鼠标事件点击元素中心；`type` 聚焦后插入文字。
- **eval 结果**：基础类型直接输出，对象输出 JSON。
- **截图**：保存为 PNG（用绝对路径），之后可查看图片确认页面状态。
- **多步任务**：导航 → 读文本 → 决策 → 点击/输入 → 验证，尽量短平快。
- **报错处理**：`Profile ... has no DevToolsActivePort` = 窗口还没起来，等待后重试或先 `open`；`API 401` = Token 文件缺失，去应用"设置 → API 文档"里复制 Token。

## 参考

本地 API 详情（认证、接口、CDP 布局、故障排查）见 `references/api.md`。
