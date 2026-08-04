# MatrixFlow Skills

为 [MatrixFlow 指纹浏览器](https://browser.lingjingxia.com) 准备的 Codex 技能集合，让 AI 助手（Codex 等）能够直接接管浏览器窗口完成网页任务。

## 技能列表

### matrixflow-browser-control（浏览器控制）

让 AI 像真人一样使用 MatrixFlow 浏览器：

- 打开 / 关闭浏览器窗口（环境）
- 浏览网页：导航、搜索、填表单、点按钮、输入文字、滚动
- 读取页面：提取文本、标题、执行任意 JS、截图
- 真人式浏览：随机节奏、切换图片、滚动评论区、给笔记点赞（见 `scripts/human-browse.mjs`）
- 多标签页管理：列出标签、锁定目标标签、激活为活动标签页
- 批量任务：`run` 模式一次连接执行整串操作，速度最快

## 安装到你的 AI 工具

### 方式一：复制到 Codex 技能目录（推荐，最简单）

把 `matrixflow-browser-control` 文件夹复制到 Codex 的技能目录，Codex 会自动发现：

```bash
# Windows（PowerShell）
$env:USERPROFILE\.codex\skills   # 技能目录
Copy-Item -Recurse matrixflow-browser-control "$env:USERPROFILE\.codex\skills\"

# macOS / Linux
cp -r matrixflow-browser-control ~/.codex/skills/
```

复制完成后重启 Codex（或新开会话），技能即可用。

### 方式二：克隆整个仓库

```bash
git clone https://github.com/yijianghe/matrixflow-skills.git "$HOME/.codex/skills/matrixflow-skills"
```

### 方式三：其它 AI 工具

该技能本质是一组“说明文档 + Node.js 脚本”：

- 支持 Codex 技能格式的工具：直接使用上面的安装方式。
- 其它 Agent 工具：把 `matrixflow-browser-control/SKILL.md` 作为系统提示词/工具说明注入，并让 Agent 可以执行 `scripts/mf-browser.mjs`（Node >= 22）。
- 纯手工使用：直接运行 `node scripts/mf-browser.mjs` 的命令即可，见下方“快速开始”。

## 使用前提

- 本机已安装并登录 [MatrixFlow 桌面应用](https://browser.lingjingxia.com)（技能通过其本地 API `127.0.0.1:19527` 控制浏览器）。
- Node.js >= 22（脚本只用内置 `fetch` + `WebSocket`，零依赖）。

## 快速开始

```bash
node matrixflow-browser-control/scripts/mf-browser.mjs status
node matrixflow-browser-control/scripts/mf-browser.mjs list
node matrixflow-browser-control/scripts/mf-browser.mjs open <profileId|name> https://example.com
node matrixflow-browser-control/scripts/mf-browser.mjs text <profileId>
node matrixflow-browser-control/scripts/mf-browser.mjs screenshot <profileId> page.png
```

真人式浏览（示例：浏览 5 篇小红书笔记，给第 3 篇点赞）：

```bash
node matrixflow-browser-control/scripts/human-browse.mjs \
  <profileId>@小红书 https://www.xiaohongshu.com/explore --notes 5 --like 3
```

## 文档

- 使用说明（中文）：`matrixflow-browser-control/SKILL.md`
- 本地 API 参考（中文）：`matrixflow-browser-control/references/api.md`

## 常见问题

- **提示 API 不可达**：先启动 MatrixFlow 应用，再运行 `status`。
- **提示 Token 缺失**：在应用"设置 → API 文档"里复制 Token，或确认 `local-api-token.txt` 存在。
- **窗口没反应**：确认环境窗口已 `open` 且处于运行状态。
- **多标签定位不稳**：用 `profileId@网址片段` 而不是序号。

## 许可

MIT License。本项目与 MatrixFlow 官方无隶属关系，是第三方技能。
