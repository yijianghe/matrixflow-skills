# MatrixFlow Skills

为 [MatrixFlow 指纹浏览器](https://browser.lingjingxia.com) 准备的 Codex 技能集合，让 AI 助手（Codex 等）能够直接接管浏览器窗口完成网页任务。

## 技能列表

### matrixflow-browser-control（浏览器控制）

让 AI 像真人一样使用 MatrixFlow 浏览器。这是本仓库的核心技能，一个技能覆盖全部能力：

### 一、窗口（环境）管理

- 创建窗口：`create <name> [--count N] [--prefix P]`（指纹自动克隆，支持批量）
- 创建窗口并绑定代理：`create <name> --proxy host:port[:user:pass]`（默认 SOCKS5，自动建代理并关联）
- 打开 / 关闭 / 删除窗口：`open` / `close` / `delete`
- 批量并发打开：`open-batch id1,id2,...`
- 查看运行状态：`list` / `status`
- 代理出口 IP 自动验证：打开 `https://api.ip.sb/geoip` 即可确认流量走代理

### 二、浏览器自动化（CDP 直连，速度快）

- 导航、等待加载：`navigate`
- 读标题 / 正文：`title` / `text`
- 点击、输入、滚动：`click` / `type` / `scroll`（真实 CDP 鼠标事件）
- 执行任意 JS：`eval`（支持 stdin 传脚本）
- 截图：`screenshot`
- 多标签页：`pages` 列出，`profileId@网址片段` 锁定标签，可激活为活动标签页
- 批量步骤：`run` 模式一次连接执行整串操作（导航→读→点→输入→验证），最快路径

### 三、真人式浏览（防查重、差异化）

- 随机打开时长、停留、滚动次数、切图次数、评论区浏览次数
- 随机点赞 / 收藏，频率低且随机（`scripts/human-browse.mjs`）
- 打标签、养号 SOP（见 `references/xhs-leadgen.md`）

### 四、小红书矩阵运营（引流陪跑）

- 搜索爆款、按互动排序：`xhs-marketing.mjs reference`
- 打标签养号、评论区截留、私信引导 SOP
- 发笔记（已攻克新版创作页）：
  - 平台原生「写文字生成图片」封面，无需本地素材
  - 标题、正文、话题自动填充（标题限 20 字）
  - 「仅自己可见」自动设置 + 发布（shadow DOM 按钮已攻克）
  - 完整流程见 `references/xhs-publish-native-text-to-image.md`

### 五、Automa 工作流 / RPA 自动化

- 打开 Automa 设计器：`automa-open <workflowId>`
- 新建 / 列出 / 同步工作流：`workflow-create` / `workflow-list` / `workflows/sync`
- RPA：目标标签页管理、执行脚本、发送消息、运行守卫

### 六、窗口同步器

- 保存窗口+标签页布局为快照，一键恢复，跨设备导入导出
- 本地 API：`POST/GET /api/v1/window-sync/snapshots`、`POST .../restore`、`DELETE .../:id`

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

带代理创建窗口（一条命令，自动验证代理）：

```bash
node matrixflow-browser-control/scripts/mf-browser.mjs create "演讲词" \
  --proxy "dc.decodo.com:10115:user-xxx-ip-82.23.21.220:password"
```

发布小红书笔记（原生文字生成图片 + 仅自己可见）：

```bash
node matrixflow-browser-control/scripts/mf-browser.mjs open <profileId> \
  "https://creator.xiaohongshu.com/publish/publish?source=official"
# 然后按 references/xhs-publish-native-text-to-image.md 的 CDP 步骤执行
```

## 文档

- 使用说明（中文）：`matrixflow-browser-control/SKILL.md`
- 本地 API 参考（中文）：`matrixflow-browser-control/references/api.md`
- 带代理创建窗口（中文）：`matrixflow-browser-control/references/create-window-with-proxy.md`
- 小红书发布流程（中文）：`matrixflow-browser-control/references/xhs-publish-native-text-to-image.md`
- 小红书矩阵引流 SOP（中文）：`matrixflow-browser-control/references/xhs-leadgen.md`

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `status` / `list` | 查看应用状态 / 运行中的窗口 |
| `create <name> [--count N] [--proxy ...]` | 创建窗口（可批量、可绑代理） |
| `open` / `close` / `delete` / `open-batch` | 打开 / 关闭 / 删除 / 批量打开 |
| `navigate` / `title` / `text` | 导航、标题、正文提取 |
| `click` / `type` / `scroll` / `eval` / `screenshot` | 点击 / 输入 / 滚动 / 执行 JS / 截图 |
| `pages` / `profileId@片段` | 多标签管理 |
| `run` | 单连接批量执行 |
| `automa-open` / `workflow-*` | Automa 工作流 |
| `xhs-marketing.mjs` / `human-browse.mjs` | 小红书运营 / 真人浏览 |

## 速度说明

- 脚本直连窗口级 CDP WebSocket，跳过浏览器级 attach 往返
- `run` 模式单连接执行整串步骤，避免逐命令重启进程
- 创建带代理窗口实测约 0.5 秒，代理出口 IP 验证约 8 秒
- 所有等待用轮询（readyState / 元素出现）而非固定 sleep

## 常见问题

- **提示 API 不可达**：先启动 MatrixFlow 应用，再运行 `status`。
- **提示 Token 缺失**：在应用"设置 → API 文档"里复制 Token，或确认 `local-api-token.txt` 存在。
- **窗口没反应**：确认环境窗口已 `open` 且处于运行状态。
- **多标签定位不稳**：用 `profileId@网址片段` 而不是序号。

## 许可

MIT License。本项目与 MatrixFlow 官方无隶属关系，是第三方技能。
