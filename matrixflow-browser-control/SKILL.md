---
name: matrixflow-browser-control
description: '控制 MatrixFlow 指纹浏览器（窗口=环境）：打开/关闭浏览器窗口、浏览网页、点击、输入、滚动、提取文本、执行 JS、截图。当用户要求用 MatrixFlow 浏览器（或某个浏览器窗口/环境）浏览网站、搜索、填表单、采集页面、查看页面或完成网页任务时使用。'
---

# MatrixFlow 浏览器控制技能

通过本地 HTTP API 和 Chrome DevTools 协议（CDP）驱动 MatrixFlow 指纹浏览器的窗口（"环境"）。这是 AI 接管浏览器窗口的完整能力：打开真实浏览器窗口、导航页面、与页面交互、读取内容、截图。

## 前置条件

- MatrixFlow 桌面应用正在运行（如果 `status` 显示 API 不可达，先启动应用）。
- MatrixFlow 客户端已**登录账号**（新建/删除环境、绑定代理都要走云端，未登录会失败）。
- **零配置**：本地 API Token 由应用启动时自动生成、技能自动读取，客户**不需要**提供任何 Token / API 密钥。
  如果之前手动写过错误 Token 导致 401：删除 `%APPDATA%\@matrixflow\desktop\local-api-token.txt` → 重启客户端即可。
- Node.js >= 22（脚本只使用内置的 `fetch` + `WebSocket`，无任何 npm 依赖）。
  - 如果客户电脑没装 Node：让 Agent 在 `%LOCALAPPDATA%\OpenAI\Codex\runtimes` 里找应用自带的 `node.exe` 来运行脚本（`& 那个node.exe scripts\mf-browser.mjs doctor`）。
- 脚本：`scripts/mf-browser.mjs`（用 `node` 运行）。

## 客户使用说明（安装即可用，直接发指令）

装好技能、MatrixFlow 已启动并登录后，客户可以直接用大白话给指令，例如：

- “打开 1 号窗口，帮我养号打标签，8 分钟”
- “先打标签再养号，养 5 分钟就行”
- “帮我创建 5 个窗口，命名小红书，平台选小红书”
- “打开 3 号窗口，发一篇小红书笔记，尽自己可见，帮我写种草文案”
- “去小红书评论区截流，找 20 条有意向的评论，用不同话术回复”
- “看私信，把问价格的都回复了”
- “打开 2 号窗口，去 Facebook 发一篇种草帖，公开，带图片”
- “删除最后两个窗口”
- “把窗口同步备份一下”

技能能做的主要功能：

1. **窗口/环境管理**：创建、打开、关闭、删除窗口；批量创建（`create`）；绑代理（`--proxy`）；新账号自动用默认指纹，无需手动建模板。
2. **浏览器控制**：导航、点击、输入、滚动、读文本、执行 JS、截图；多标签页切换。
3. **小红书养号/打标签**：按内容自动决定每篇浏览时长（20-90 秒，每篇不同），模拟真人刷发现页、看图、滚评论区、看二级/三级评论、概率点赞收藏；默认会话 **8 分钟**，客户可选 5/10/15 分钟。
4. **小红书发笔记**：文字转图片/本地图片，标题+正文+话题（≥3 个相关话题），默认尽自己可见，可公开发布、定时发布，文案不重复。
5. **评论区截流 + 私信截流**：扫同行爆款评论区识别意向客户，不同话术种草回复，私信先聊两句再引导。
6. **Facebook 发帖**：图片+文案种草帖，公开可见，可带随机定位、进小组发帖。
7. **公众号推文**（配合对应窗口）：在已登录的公众号窗口编辑并发布推文。
8. **任务栏序号角标**：打开窗口后，任务栏每个窗口图标右下角显示序号（需 v1.10 及以上客户端）。

建议客户这样说：“先 `doctor` 自检，然后打开 X 号窗口，帮我做 XX，时间 XX 分钟”。

## 快速开始

```bash
node scripts/mf-browser.mjs doctor           # 新电脑第一步：环境自检（每个 [FAIL]/[WARN] 都有解决指引）
node scripts/mf-browser.mjs status          # 确认应用在运行 + Token 正常
node scripts/mf-browser.mjs list            # 列出运行中的环境（窗口）
node scripts/mf-browser.mjs open <id|name>  # 打开一个环境窗口
node scripts/mf-browser.mjs navigate <id|name> https://example.com
node scripts/mf-browser.mjs text <id|name>
```

先运行 `status`：它会输出 API 地址、应用是否在运行、Token 是否存在。如果应用没在运行，先启动 MatrixFlow，再重新检查。

## 新电脑部署（换机器必看）

换一台电脑装好技能后，**第一步先运行 `doctor` 自检**，它会逐项检查并直接告诉你缺什么：

```bash
node scripts/mf-browser.mjs doctor
```

常见情况与处理：

1. **`[FAIL] MatrixFlow 客户端未运行`**：先打开 MatrixFlow 应用，确认“设置 → API”已开启。
2. **`[WARN] 本地 API Token 未配置`**：MatrixFlow 设置 → API 文档里能看到本地 API Token，把 Token 内容写入 `userData/local-api-token.txt`（即 `%APPDATA%\@matrixflow\desktop\local-api-token.txt`），或用环境变量 `MF_LOCAL_API_TOKEN`。
3. **`[WARN] 云端账号未登录`**：新建/删除环境、绑定代理必须走云端。请打开 MatrixFlow 客户端**登录你的账号**，再重新运行 `doctor`，直到该项变为 `[PASS]`。
4. **`[WARN] 当前没有任何环境`**：首次使用请先在客户端里手动创建一个环境，之后 `create` 才能克隆指纹批量新建。
5. **`[FAIL] Node.js 版本过低`**：安装 Node.js 22+（https://nodejs.org），装完重新打开终端再试。

> 在别的电脑上“创建窗口失败”绝大多数是第 3 条：**客户端没登录**。`create` 是走云端新建的（本地接口只是透传），必须登录后才能用。
> 部分客户端版本本地接口不支持新建/删除环境，脚本已自动回退到云端接口，无需额外处理；只要客户端已登录即可。
> 如果 `doctor` 显示“云端登录令牌未找到”但客户端明明已登录，请**用管理员身份重新打开终端**再运行（读取 Windows 系统凭据需要权限）。
> **重要：如果 `doctor` 自检全部 `[PASS]`，不要修改任何脚本**——所有兼容修复已内置（版本号见 doctor 第一行）。
> 若 Agent 说要“打补丁/改代码”，先看 `doctor` 是否输出“内置兼容修复齐全”，是则直接使用，不需要改。

### 新电脑安装后 3 步（必看）

1. **打开 MatrixFlow 客户端并登录账号**（新建/删除窗口必须走云端，未登录会失败）；
2. **无需复制任何 Token**：MatrixFlow 启动时会自动生成本地 API Token 并写入
   `%APPDATA%\@matrixflow\desktop\local-api-token.txt`，技能会自动读取，不需要在界面里找。
   ⚠️ 注意：界面左侧“API 密钥”里的 `mf_live_...` 是**云端 API 密钥**，不是本地 Token；
   不要把它写进 local-api-token.txt。如果之前写错过：**删除该文件 → 重启 MatrixFlow 客户端**，
   应用会自动重新生成正确的 Token。
3. **直接创建窗口**：`node scripts/mf-browser.mjs create "小红书1" ...`
   ——新账号没有任何环境时，脚本会**自动使用内置默认指纹**创建，**无需手动先建一个环境做模板**。

排错速查：
- 接口全部 401 → local-api-token.txt 被写成了云端密钥（`mf_live_`）或与内存不一致：
  **删除该文件 → 重启 MatrixFlow 客户端**，应用会自动重新生成正确 Token；
- “没有可用指纹模板” → 更新到本版本（已内置默认指纹，不再需要手动建模板）；
- 云端未登录（`doctor` 显示）→ 先在客户端登录账号。

## 工作流程

1. **确认应用在运行**：`node scripts/mf-browser.mjs status`。如果 `appRunning` 为 false，启动 MatrixFlow 并等待几秒后重试。
2. **选择窗口**：`node scripts/mf-browser.mjs list` 返回运行中的环境。后续所有命令使用其中的精确 `profileId`（或名称）。
3. **如需打开窗口**：`open <id|name> [url ...]` 启动环境，命令会等待 Chromium CDP 就绪后返回，无需再盲目等待。
4. **交互**：导航 → 等待加载 → 读取 `text`/`title` → `click`/`type`/`scroll` → 用 `text` 或 `screenshot` 验证。
5. **收尾**：完成后 `close <id|name>`（可选；用户想保留窗口就不关）。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `doctor` | 完整环境自检：Node/应用/Token/登录状态/指纹模板，逐项给出修复指引（新电脑先跑） |
| `status` | 显示应用状态、API 地址、Token、userData 路径 |
| `list` | 列出运行中的环境（profileId、状态、url） |
| `open <id\|name> [url ...]` | 打开环境窗口（可带启动网址），等待就绪后返回 |
| `open-batch <id1,id2,...>` | 并发批量打开多个环境（每批 3 个，速度快） |
| `create <name...> [--count N] [--prefix P]` | 新建环境（可一次传多个名称全部创建；指纹克隆自第一个环境；--count 批量、--prefix 命名前缀） |
| `create <name...> --proxy host:port[:user:pass]` | 新建一个或多个环境并绑定同一代理（默认 SOCKS5，自动创建代理并关联；同名会拦截） |
| `delete <id\|name>` | 删除环境 |
| `close <id\|name>` | 关闭环境窗口 |
| `automa-open <workflowId> [--profile <id>] [--name <name>]` | 打开 Automa 设计器编辑工作流 |
| `workflow-create <workflowId> [name]` | 新建 Automa 工作流 |
| `workflow-list` | 列出全部工作流（精简摘要） |
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
echo '[{"op":"navigate","url":"https://example.com"},{"op":"waitReady"},{"op":"eval","js":"document.title"},{"op":"screenshot","path":"shot.png"}]' | node scripts/mf-browser.mjs run <id|name> -
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

**发现页养号循环 v2（2026-08-05 重构，已实测验证）**：`scripts/xhs-feed-browse.mjs`

每篇笔记强制完整执行，全程拟真人、动作差异化：

1. 发现页随机选未浏览卡片，真实鼠标点击打开；
2. 检测笔记类型：视频 / 多图（1/N 页码）/ 单图；
3. **只滚动右侧内容面板 `.note-scroller`**（正文 + 评论区都在里面），详情打开后**绝对禁止滚动 window/背景瀑布流**；
4. **内容化停留时长**：先读笔记内容（图片数 / 正文长度 / 视频时长）估算“真人阅读时间”，
   图文 20-90 秒、视频按播放进度 30-120 秒，**每篇都不一样**，绝不统一；另有 `--min-dwell` 兜底下限；
5. 多图笔记切图 1-3 次，每次用轮播快照（活跃圆点 / 大图地址 / transform）对比验证确实切换；
6. 滚评论区 2-4 次，滚到底自动停；随机点开 1-3 个“展开 N 条回复”（`.show-more`）看二级评论，展开后再点嵌套的“查看回复/条回复”看三级评论，用 `.note-scroller.scrollHeight` 增长验证；
7. 概率互动（默认：点赞 35%、收藏 20%），互动前检查 `like-active` / `collect-active` 状态，已互动不再点；用数字 +1 验证成功，数字 -1 自动恢复；
8. 每日安全上限：点赞 ≤ 30、收藏 ≤ 20（`--max-likes` / `--max-collects` 控制）；
9. 关闭笔记（`.close-circle`）并确认已关闭 → 滚发现页 500-800px → 下一篇；
10. 所有动作次数、间隔、停留时长全部随机，禁止每篇同一套动作模板。

```bash
# 养号/打标签：默认会话 8 分钟（自动按内容决定每篇浏览时长）
node scripts/xhs-feed-browse.mjs <profileId> --session 8
```

- `--session N` — **会话时长（分钟，默认 8）**：养号/打标签默认 8 分钟；客户可以选 5/10/15 分钟等
- `--rounds N` — 浏览笔记篇数下限（默认 6；会话时间没到会自动继续刷）
- `--like-ratio 0.35` — 点赞概率（默认 0.35）
- `--collect-ratio 0.2` — 收藏概率（默认 0.2）
- `--max-likes 30` — 单次运行点赞上限（默认 30）
- `--max-collects 20` — 单次运行收藏上限（默认 20）
- `--min-dwell 25` — 每篇最短停留秒数兜底（默认 25）
- 示例：`node scripts/xhs-feed-browse.mjs cmseose200emqpkjq82p387jj --session 8 --like-ratio 0.4`

站点注意点：小红书要点击笔记**卡片**（`section.note-item`），而不是卡片里的 `<a>` 锚点（它的矩形是 0，点不到）；笔记详情链接通常带 `xsec_token`，直接重开可能被重定向回列表。

## 小红书陪跑导师（养号 / 截留）

当用户要求“写小红书养号/截留/引流脚本”时，把你自己当作陪跑导师，按以下流程走（脚本：`scripts/xhs-marketing.mjs`）：

1. **先问清楚**（如果用户没说全）：行业/产品是什么、目标城市、引流平台（默认小红书）、种草话术的风格/素材。
2. **打标签（tag）**：用行业关键词搜索并真人式浏览几篇，训练账号的推荐算法：
   ```bash
   node scripts/xhs-marketing.mjs <profileSpec> tag <关键词...> --notes 5
   ```
3. **选爆款（pick）**：搜索并按点赞数排序，找到评论区截留的最佳目标：
   ```bash
   node scripts/xhs-marketing.mjs <profileSpec> pick <关键词...> --top 3
   ```
4. **评论区截留（intercept / full）**：在爆款笔记下发布种草评论（先向用户确认话术再发布）：
   ```bash
node scripts/xhs-marketing.mjs <profileSpec> intercept <关键词> --title <标题片段> --comment "成都这家SPA真的很好，环境舒服手法专业，姐妹可以冲！"
   node scripts/xhs-marketing.mjs <profileSpec> full <关键词...> --comment "<话术>"
   ```

作为陪跑导师，**按 `references/xhs-leadgen.md` 的矩阵引流 SOP 执行**：先问清行业/城市/门店/可用账号数 → 给出 7/14 天排期表 → 每天按 SOP 打标签、选爆款、截留、发笔记 → 每周复盘调整。

SOP 核心数字（详见手册）：
- 打标签：每天 4-6 组关键词、12-20 篇浏览，连养 7-14 天；新号前 3 天只浏览不评论；
- 截留：每天 2-3 条、间隔 ≥ 1 小时、话术 20-60 字必做变体；评论可见率 < 70% 就降频回养号；
- 发笔记：发前先 `pick --top 10` 参考爆款改写，每周 2-3 篇，晚 8-10 点发布；
- 矩阵：主号发文、人设号种草、素人号评论，账号独立环境+指纹，操作间隔 ≥ 30 分钟。

## 全行业引流陪跑 SOP 生成（你说行业 → 我出整套方案）

用户说"我是做 XX 的"，就按 **`references/xhs-industry-sop.md`** 现场生成整套 7/14 天引流转化 SOP：养号 → 打标签 → 爆款选题 → 发笔记 → 评论区截流 → 私信截流 → 时间排期 → 风控。

生成步骤（禁止跳过）：
1. **填行业画像五要素**：目标人群 / 核心痛点 / 决策路径 / 场景词 / 竞争词（拿不到就问用户，别瞎编）；
2. **套九步模板**：账号矩阵 → 打标签关键词矩阵 → 养号（真人行为+安全阈值）→ 爆款选题（`pick` 拉 Top 10-15 拆结构）→ 共鸣体发笔记 → 评论区截流（小号承接）→ 私信截流（先聊两句再引导，不甩微信）→ 时间排期（早中晚碎片时间）→ 风控红线；
3. **输出排期表 + 当天执行清单**，然后直接用脚本执行（`xhs-marketing.mjs` / `xhs-feed-browse.mjs` / 发布流程）；
4. 每完成一天就记录进度，复盘调整。

评论区"留钩子"识别（同行截流特征，看到就懂）：求地址/求链接、私我/私你、扣1/暗号、关键词埋点（"搜XX看第一篇"）、双簧对话、置顶楼中楼。识别后用小号差异化承接，一天 2-3 条封顶。

已吸收行业案例库（可直接套用）：SPA/本地生活、商K/商务接待、毕业论文/论文辅导、私域粉/虚拟资料。新行业按五要素现填现生成。

**行业快速出稿库（2026-08-06 新增）**：`references/xhs-industry-fastcopy.md` 内置 8 个行业的
现成标题备选 + 正文骨架 + 话题 + 截流话术（商K/毕业论文/私域资料/美业/餐饮/家居/教育培训/本地生活）。
用户说行业 → 直接查表拼装文案 → 快速搜一次最近爆款确认角度 → 发布。出稿+发布整体目标 ≤ 1 分钟
（封面走缓存时实测发布流程 ~15 秒；全新封面首次生成需等平台 GPU 30-60 秒）。

**100+ 行业速查库（2026-08-06 新增）**：`references/xhs-industry-100.md` 按「卖产品 / 卖货 / 卖服务 / 卖知识」
四类收录 100+ 常见行业（美妆/服装/餐饮/美业/教育培训/留学/论文/私域资料等），每行给出
人群 / 痛点 / 标题方向 / 话题标签，说行业直接拼装文案。

## 智能截流（评论区截留 + 私信分流）

用 `xhs-marketing.mjs scan` 扫描同行笔记评论区，自动分辨意向客户；再用 `reply` 种草式回复、`reference` 收集爆改素材。

```bash
# 1) 扫描：读同行评论区，标记意向客户（--city 用于判断是否本地帖子）
node scripts/xhs-marketing.mjs <profileSpec> scan <关键词...> --top 5 --city 成都
# 2) 回复某条求地址/求推荐的评论（截流）
node scripts/xhs-marketing.mjs <profileSpec> reply <关键词> --to '<评论片段>' --comment '<回复话术>' [--title <标题片段>]
# 3) 收集爆款结构 + 评论区高频问题，供改写发布到自己的账号
node scripts/xhs-marketing.mjs <profileSpec> reference <关键词...> --top 5
```

分辨规则（陪跑导师按此判断）：
- **意向客户**：评论像提问（以问号结尾，或以 求/哪里/怎么/多少钱/有没有/适合 开头）——分三类：求地址、求推荐、问价格；
- **本地帖子**：标题含目标城市（`--city`），本地帖子才值得截留；跨城帖子跳过；
- **回复 vs 私信**：求地址/求推荐 → 评论区公开回复（别人也能看到，增加信任）；问价格/要联系方式/深度咨询 → 走私信（不公开留联系方式）；
- **爆改参考**：`reference` 收集的爆款笔记（标题结构/点赞/评论区高频问题）用于改写，禁止原文抄袭。

## 评论区二级/三级评论（2026-08-06 强化）

- `scan` 已支持**自动展开二级/三级评论**（点"展开 N 条回复"和嵌套"查看回复"）后再收集意向客户；
- 回复二级/三级评论：用 `reply` 定位到具体评论片段即可（在回复楼里继续回复，作者删不掉，同城曝光更大）；
- 判断意向不只看一级评论：二级/三级回复里经常有"姐妹求带""在哪里做的""多少钱"等高意向客户。

## 私信 SOP（2026-08-06 新增）

1. `node scripts/xhs-marketing.mjs <id> inbox` → 打开网页版消息页（`https://www.xiaohongshu.com/chat`），
   输出会话/未读私信文本；
2. 网页版会话列表若未加载（需 App），提示用户用 App 查看，或在消息页用 `click/type` 手动操作；
3. 回复私信遵循「延迟满足」：先聊两句纯客服（"有的哦，你要哪个呀？"）→ 给正当理由
   （"点我瞬间看细节图""回个 1 自动发你资料"）→ 再引导主页/置顶笔记；
4. 禁止第一句甩微信/链接；每日私信引流 ≤50 人；出现"操作频繁"立即降频。

## Facebook 种草发帖（2026-08-07 新增）

### Facebook 自动化工作流（Automa，2026-08-11 新增）

内置工作流：`resources/automa-workflows/fb-auto-posting.automa.json`

**功能**：读取谷歌表格（关键词/文案/群聊/评论）→ 打开 Facebook → 自动切简体中文 → 检查登录 →
搜索关键词打开帖子浏览点赞评论 → 进入小组分享帖子 → 上传图片发布。

**谷歌表格模板**：https://docs.google.com/spreadsheets/d/1akNZK1qV-We18E4m2rqMuybBUYgctUuBbSjn3DNqQsQ
- 第一列/第一行英文不能删不能动，否则出错；
- 列结构：path（图片路径）、name（关键词）、copy（文案）、group chat（群聊内容）、
  timed release、keywords（搜索词）、jianghe/huanhuan/tiantian/gege…（各账号评论内容）。

**导入到 MatrixFlow**：
- 首次导入（推荐）：打开一个窗口 → 在浏览器里打开 Automa 面板（chrome-extension:// Automa dashboard）
  → 工作流 → 导入 → 用 `upload` 命令把 `fb-auto-posting.automa.json` 注入文件选择框完成导入；
- 更新内容：`node scripts/mf-browser.mjs workflow-import resources/automa-workflows/fb-auto-posting.automa.json fb_auto "Facebook自动化"`。
  > 注意（2026-08-11）：MatrixFlow 云端的 `workflow/sync` 接口当前不可用（init 创建的 stub 无法被
  > sync 找到，往返同步也会 500「Workflow not found」），`workflow-import` 可能只导入出 1 个 trigger。
  > 遇到「工作流内容空/只有 1 个节点」时，改用 Automa 面板手动导入：
  > `automa-window` 打开工作台 → 工作流 → 导入 → 选 `fb-auto-posting.automa.json`。

**Automa 独立工作台窗口（2026-08-11 新增，类似比特浏览器）**：
```bash
node scripts/mf-browser.mjs automa-window
```
会在独立窗口（非标签页）打开 Automa 工作流页面，使用独立轻量 profile 和 Automa 图标，
不占用业务窗口、不影响业务窗口的登录状态。配合 `workflow-import` 导入工作流后即可编辑运行。
> 修正（2026-08-11 实测）：不要在业务窗口里 `Target.createTarget(newWindow)` 打开 Automa 面板——
> 那个窗口会渲染空白/显示「已被屏蔽」。现在一律走独立工作台（`--app` + automa-workbench），
> 实测标题为「Dashboard - Automa」，可正常浏览/运行工作流。
> **窗口形态（2026-08-11 确认）**：独立窗口 + Automa 图标（任务栏用 `automa-icon.ico` +
> AUMID `com.matrixflow.automa` 注册），**无地址栏、无浏览器标签页**（顶部是 Automa 应用
> 自己的工作流页签）。`automa-open <workflowId>` 与 `automa-window` 都走这个干净窗口；
> 设计器 URL（`mfOpenMode=designer`）会被 Chromium 拦截（ERR_BLOCKED_BY_CLIENT），
> 所以打开工作流=打开工作台列表页，用户在窗口内点击目标工作流进入设计器。

**多窗口编排（每个窗口发一行，发完关窗口开下一个）**：
1. 先读表格 CSV（表格是公开可读的）：`https://docs.google.com/spreadsheets/d/1akNZK1qV-We18E4m2rqMuybBUYgctUuBbSjn3DNqQsQ/export?format=csv&gid=0`；
2. 从第 2 行开始，每行对应一个窗口：`open <窗口>` → 确认已登录 Facebook（未登录先登录）→
   运行工作流（在 Automa 面板点击运行，或用 CDP 驱动执行）→ 发完 `close <窗口>` → 下一个窗口用下一行；
3. 也可以不用 Automa，直接用 `scripts/fb-post.mjs` / `fb-group-post.mjs` 发帖，
   再用 `scripts/fb-engage.mjs` 做搜索关键词点赞评论——效果一样，由 Agent 决定。

**账号登录**：工作流开头会检查是否已登录、是否简体中文；未登录会报错停止。
如果窗口没登录，Agent 可以用账号密码登录（或让客户扫码），登录后再跑工作流。

用 `scripts/fb-post.mjs` 在已登录的 Facebook 窗口发「种草帖」（软推广，禁止硬广）：

```bash
# 公开双语种草帖 + 3 张图（2026-08-07 实测发布）
node scripts/fb-post.mjs <profileId> --text-file D:\fb-post.txt \
  --image D:\a.png --image D:\b.png --image D:\c.png --visibility public \
  [--random-location]     # 随机带定位；或 --location "成都"

# 带视频（需现成视频文件）
node scripts/fb-post.mjs <profileId> --text-file D:\fb-post.txt --video D:\v.mp4 --visibility public

# 群组发帖：搜索小组 → 进入 → 群内发
node scripts/fb-group-post.mjs <profileId> --keyword "digital marketing" \
  --text-file D:\fb-post.txt --image D:\a.png
# 或直达群组: --group https://www.facebook.com/groups/xxxx
```

**v4 关键修正（2026-08-07）**：
- **先传图、后写文案**：之前先写文案再传图，Facebook 编辑器会把文案吞掉；
- **发布前校验**：文案探针在编辑框 + 图片预览数达标，缺哪个补哪个，全绿才点发布；
- **随机定位**：`--random-location` 从城市列表随机选一个（成都/上海/北京/深圳/广州/杭州/重庆/Sydney/Melbourne/Singapore/Kuala Lumpur），定位选择失败会自动撤销，绝不导航离开发布页；
- **--no-post 模式**：只把图文/定位/公开准备好、不点发布（供人工最后确认时使用）。

**v5 图文同框配方（2026-08-07 实测验证，最重要）**：
- Facebook 会把发布框渲染成多层（传图后会**新开一个带图弹窗**叠在上面）；
- 必须把文字写进**带图弹窗**的文字框：先真实鼠标点击该文字框聚焦（不滚动），
  再 `execCommand('insertText')`——只有这样才能图文同框；
- 发布按钮要点**带图弹窗**里的「发帖」（合成事件/原生 click 都行，坐标会重叠，
  必须从带图弹窗内部找按钮）；
- 带图弹窗里出现的「这项内容无法与已添加的内容一起加入帖子」是**虚报**，不影响发布；
- 点完发帖后「带图弹窗消失」即视为提交成功，**不要重试**（重试会误发纯图帖）；
- 每帖稳定用 **1 张图**（多图会触发真实冲突、禁用发帖）。

**种草文案规则（让用户为产品买单，但不发广告）**：
- 第一人称体验式：痛点 → 偶然发现 → 用了之后的变化 → 价值点 → 软引导；
- 讲具体场景（多账号被关联、登录态混乱、重复劳动），不喊口号；
- **公开可见**：`--visibility public`（发布框内自动点「公开」+「完成」）；
- **中英双语**：正文中文 + 英文各一段，末尾加中英话题标签各 2-4 个（`#指纹浏览器 #多账号运营 #AntidetectBrowser #MultiLogin` 等）；
- 可附真实截图（如 MatrixFlow 应用的多窗口列表），比文字更有说服力；
- 结尾放官网即可（如 browser.lingjingxia.com），不夸大、不承诺效果；
- 每篇换角度，禁止同一账号连续两篇同结构同话术（参考小红书文案铁律）。

**脚本自动处理**：
- 打开首页发布框 → 逐行输入文案（ProseMirror 兼容）→ 注入图片/视频 → 设公开 → 点「发帖/Post」→ 验证发布框关闭且页面出现文案；
- 自动清理重复附件：Facebook 网页版对重复图片会报「这项内容无法与已添加的内容一起加入帖子」并禁用发帖按钮，脚本会先移除旧附件；
- 自动关闭叠层空发布框（Facebook 会渲染两个 composer，空的叠在上面会挡住发帖）；
- 发帖按钮中文「发帖」/ 英文「Post」，合成事件 + 真实坐标点击双保险、失败自动重试；
- 文案历史去重：`<userData>/fb-post-history.json`，相似度 >0.55 拒绝二发。

**v6 关键修正（2026-08-11 实测验证）**：
- **公开可见设置修复**：之前设「公开」偶发失效（帖子以「你的好友」发出）。根因有两个：
  校验时可能读到另一层重复发布框的隐私按钮、以及隐私弹窗渲染时序未就绪导致点空。现在：
  - 发布前设公开带 **3 次重试**，每次间隔更长；
  - 校验锁定「带图弹窗」内的隐私按钮文字，`编辑隐私设置。分享对象：公开。` 才算成功；
  - 2026-08-11 已在 脸书4 实测发布成功，个人主页显示「分享对象：公开」；
- **发布框打开加固**：自动先关掉「创建 PIN 码」等遮挡弹窗；找不到「分享你的新鲜事」按钮时
  用文本兜底点击；最多重试 20 次；
- **群组发帖修复（fb-group-post.mjs）**：
  - 群链接过滤：排除 `/groups/` 根地址、`/groups/you` 等无效链接，只进真实小组；
  - 未加入的小组自动点「加入小组」（最多 3 次）；
  - 首次发帖的「互动必答题」自动处理：逐一点未勾选的正面选项（Both/Yes/Agree/同意/是）、
    滚动弹窗露出更多选项、勾选规则、点可用的「提交」（注意存在禁用的提交副本，
    要点 `aria-disabled` 非 true 的那个）；
  - 群发布框图片：锁定 `[role=dialog] input[type=file]` 注入，预览计数只看弹窗内图片；
  - 群发布框文案：编辑框高度 ≥15px 即可（群弹窗里是 20px 单行，之前被「高度>20」过滤掉导致
    「群内文案输入失败」）；
  - 2026-08-11 已在公开小组实测发布成功（自动加入 → 图文同框 → 提交）；

**v7 图文不丢 + 自动配图（2026-08-11 优化）**：
- **「传图后文案消失」根因修复**：Automa 工作流里发帖文字用的还是旧选择器 `textarea.textbox`，
  当前 Facebook 已改成 contenteditable div，文字根本没写进去 → 帖子只有图没有文。
  已把工作流 node 90 的选择器改为 `[role="dialog"] div[contenteditable="true"]`；
- **发布框强制回首页**：fb-post.mjs 之前只在「非 facebook.com」时才导航首页，
  如果标签页停在搜索页会一直找不到发布框。现在只要不是首页就强制导航 `facebook.com/`；
- **自动挑图（每次图片不一样）**：不传 `--image` 时自动扫描
  `Documents\ShareX\Screenshots`、`Downloads`、`Pictures`、`%APPDATA%\@matrixflow\desktop\fb-images`
  里的图片，并记录已用图（`fb-images-used.json`），自动避开最近用过的，保证每帖配图不同；
  可用环境变量 `FB_IMAGES_DIR` 指定专属素材目录；
- **多图支持**：默认 1 张（FB 多图易触发「内容冲突」）；显式 `--multi` 时最多 3 张；
- 文案不重复靠 `fb-post-history.json` 相似度去重（>0.55 拒绝二发），配图不重复靠 `fb-images-used.json`。

**v8 多窗口批量发帖 + Reels 引导弹窗（2026-08-12 实测）**：
- **Reels「检查分享对象/更新设置」引导弹窗修复**：部分账号打开发布框时会弹出 Reels 引导
  （内含大图），脚本之前会误把它当成「带图弹窗」→ 文案写不进、发布框找不到。现在：
  - 找带图弹窗必须**同时有图片和可编辑框**，并排除含「检查分享对象/更新设置/Reels 现在」的弹窗；
  - 发布框打开后、锁定前先清一遍引导弹窗；
- **图片扫描递归**：截图在 `Screenshots\2026-08` 等子文件夹，之前只扫顶层导致「没有未用图」；
  现在递归 3 层扫描，实测可找到 100+ 张未用图；
- **批量发帖实测**：打开 1-30 号窗口检查登录 → 6 个已登录账号（脸书4/7/8/9/15/22）全部
  成功发布公开种草帖（图文+话题+官网 browser.lingjingxia.com），每账号配图不同、文案不同；
  脸书1 需本人自拍验证，其余未登录。
- **多语言发帖按钮**：fb-post.mjs 发帖按钮识别增加 韩文게시/意大利文Pubblica/西语Publicar 等，
  支持非中英文界面账号（部分账号登录成功但界面为韩/意文时也能点发布）。
- **登录与窗口管理**：未登录窗口用账号密码自动登录（邮箱/手机号+密码）；
  登录成功即可发帖；密码错误/设备验证/广告同意墙等异常窗口直接关闭；
  发布完成的窗口也关闭，保持环境干净。

## MatrixFlow 客户端 v1.13 修复记录（2026-08-12）

- **窗口尺寸生效（不再强制全屏）**：根因是启动代码写死 `--start-maximized` 且窗口尺寸硬编码
  `1280x800`。已改为读取指纹配置的屏幕宽高（fingerprint.screen），去掉强制最大化；
  实测：配置 1280x720 的窗口精确按该尺寸打开（窗口宽 1280、内容区 720）。
  注意：如果配置尺寸大于物理屏幕（如 1680x1050 > 1366x768），会被系统钳制到屏幕大小，
  看起来像全屏——这是正常行为；
- **窗口尺寸快捷选择（对齐比特浏览器）**：创建窗口 → 高级设置 → 屏幕宽度/高度下方新增
  8 个常用分辨率按钮（800x600/1024x768/1280x800/1360x768/1440x900/1600x900/1920x1080/2560x1440），
  点击自动填入宽高；
- **语言选择支持搜索（对齐比特浏览器）**：浏览器语言输入框加 datalist 搜索建议，
  输入语言代码或中文名即出现匹配列表（17 种常用语言带中文名），选中即填入；
- **仪表盘指标卡数值居中**：`mf-metric-value` 原本无 CSS 定义导致靠左，已加
  `.mf-metric-value { text-align: center }`（总环境数/运行中/异常/套餐用量全部居中）。
- **小尺寸窗口无法创建修复**：创建/编辑表单校验原来限制屏幕宽度 ≥800、高度 ≥600，
  输入 500x600 等自定义小尺寸时「创建」按钮无反应。已放宽为宽度 ≥320、高度 ≥240；
  实测 500x600 窗口成功创建并打开（精确 500x600、屏幕居中）。
- **窗口启动直接居中、不再抖动（2026-08-12 实测）**：之前是「离屏启动(-48000) →
  再挪回屏幕」两段式，打开时会先看到偏左/偏大的中间态。现已改为启动参数直接带居中坐标
  （`--window-position=x,y --window-size=w,h`），首帧就落在最终位置，彻底消除跳变；
  同时去掉离屏 park 的重复 CDP 搬移，启动时主程序占用更低。
- **高度不再被过度压缩**：Electron 传入的是工作区高度（如 1366x728，已扣除任务栏），
  之前钳制再减 60px 边距会把 720/700 的配置高度砍成 668。已改为只留 4px 保险边距，
  实测 1280x720 窗口精确以 43,4 / 1280x720 打开并居中；400x700 窗口高度精确 700、水平居中。
  注意：宽度 <500 时 Chromium 自身有最小窗口宽度（400 会被撑到 500 内容宽），属浏览器内核限制。
- **聚焦/保活按生效尺寸居中**：`BrowserRuntime` 现在保存生效的 windowSize/screenSize，
  再次点击运行中的窗口（focusProfile）或关掉最后一个标签自动重建时，按该窗口原尺寸居中，
  不再退回默认 1280x800。
- **手机尺寸窗口（对齐比特「分辨率」行为，2026-08-12 实测）**：宽度 <600 的配置
  （如 500x900 / 400x700）受 Chromium 最小窗口宽度限制无法把 OS 窗口开到 400 宽，
  现通过 CDP 视口仿真 + 注入脚本把页面渲染成配置分辨率：
  - 页面 innerWidth/innerHeight、screen.width/height 均等于指纹配置（实测 500x900、400x700）；
  - OS 窗口保持约 516 宽（Chromium 最小 500 内宽）并屏幕居中，页面按手机长条比例渲染；
  - 新建标签页、页面导航后都会自动重新套用，不会中途变回真实屏幕；
  - 桌面尺寸（宽度 ≥600，如 1280x720）行为不变。
  注意：宽度 400 的视口会按比例放大填充 500 宽的窗口，属于正常表现。

涉及文件：`packages/browser-core/src/playwright-profile-launcher.ts`、
`packages/browser-core/src/utils/window-alignment.ts`、`packages/browser-core/src/browser-manager.ts`、
`packages/browser-core/src/types.ts`、
`apps/desktop/src/renderer/assets/index-mTN2Aiv6.js`。安装包：`MatrixFlow Setup 1.13.0.exe`。

**配套工具**：
- `fb-set-public.mjs <profileId>`：把当前发布框/帖子可见范围改成「公开」；
- `fb-type-prose.mjs <profileId> <textFile>`：逐行输入（换行=Enter）；
- `fb-attach.mjs <profileId> <file1> [file2...]`：注入图片/视频；
- `fb-synthetic-post.mjs <profileId> [probeText]`：合成事件点发帖；
- `fb-click-element.mjs <profileId> <selector>`：不滚动精确点击（解决误点隐藏副本）；
- `fb-fix-attachments.mjs <profileId> [目标附件数]`：清理重复附件；
- `capture-window.ps1`：截取 MatrixFlow 应用主窗口做种草配图。

**已知限制**：
- 必须已登录（未登录会停在登录页）；
- 视频需要现成视频文件（脚本无内置编码器，不会自动生成视频）；
- 已发布帖子改可见范围：帖子 ⋯ → 改可见范围 → 选「公开」→ 必须点「保存」（关闭弹窗不生效）；
- Facebook 对自动化有风控，一天发帖量不要大，文案要自然；配图素材建议用 MatrixFlow 应用主窗口截图（多窗口列表最有说服力）；
- 详细踩坑记录（双发布框叠层/ProseMirror/隐私弹窗/重复附件冲突）见 `references/facebook-leadgen.md`。

种草文案模板与更多行业话术见 `references/facebook-leadgen.md`。

## 差异化养号（防查重）

打标签/养号时所有动作都要随机差异化（脚本已内置）：
- 每个笔记的打开时间、停留时长、滚动次数、看评论区次数、切图次数各不相同；
- 随机点赞（约 35%）/收藏（约 15%），频率低且随机，绝不连续快速操作；
- 每次会话的节奏与上一会话不同。

## 发笔记（发布流程现状）

- **快速发布脚本（推荐，2026-08-05 新增）**：`scripts/xhs-publish.mjs` —— 一条 CDP 连接走完，默认文字转图片 + 每次随机选不同模板，实测发布流程 ~10-15 秒（同封面文案走 GPU 缓存秒出；全新文案首次生成 30-60 秒是平台 GPU 耗时，无法压缩）。
  ```bash
  node scripts/xhs-publish.mjs <profileId> \
    --title "标题（≤20字）" --cover "封面文字" --body-file %USERPROFILE%\body.txt \
    [--template random|基础|美漫|插图|涂鸦|涂写|清新|边框|备忘|简约|光影|手写] \
    [--visibility 仅自己可见|公开可见|仅互关好友可见] \
    [--image <文件路径> | --image-dir <文件夹>] \
    [--schedule "YYYY-MM-DD HH:mm"] \
    [--draft]
  ```
  - 默认可见范围「仅自己可见」（私密）；要公开必须显式 `--visibility 公开可见`；
  - 正文用 `--body-file <path>` 传 UTF-8 文本文件最稳（避免命令行引号问题）；
  - **定时发布（2026-08-06 已验证）**：`--schedule "2026-08-06 20:00"`（也支持"明天 20:00"），自动开定时开关、选日期小时；**分钟采用平台默认（当前+30分钟）**，目标分钟与默认偏差 >3 时会警告（平台分钟滚动选择器在需滚动时点不准，精确分钟需在发布页人工微调）；
  - **本地图片模式**：`--image <路径>` 指定单张图，或 `--image-dir <文件夹>` 指定目录；
    默认会从下载目录（`%USERPROFILE%\Downloads`）、桌面、`%USERPROFILE%\Documents\ShareX\Screenshots` 自动找第一张可用图片。
    **客户说"用配置图片"时，告诉客户图片放在哪：下载目录、桌面，截图在 `%USERPROFILE%\Documents\ShareX\Screenshots`；也可以直接把图片放进这些文件夹，脚本会自动读取。**
- **内容生成**：用 `reference` 拉爆款结构（标题/点赞/评论区高频问题）→ 改写种草文案（体验式、不硬广、引导私信）；
- **封面图（推荐原生文字生成图片，已验证 2026-08-05）**：打开创作平台发布页 → 点击「上传图片，或写文字生成图片」→ 选「文字配图」→ 输入封面文案 → 点「生成图片」→ 平台一次生成多套排版，选「基础」→ 点「下一步」直接带入发布表单。全程不需要本地素材/占位图。详见 `references/xhs-publish-native-text-to-image.md`；
- **模板随机（2026-08-05 新增）**：文字配图生成后平台会给 10 套模板（基础/美漫/插图/涂鸦/涂写/清新/边框/备忘/简约/光影/手写），脚本默认随机选一套并验证预览图确实切换；`--template <名字>` 可固定某套。每次发布模板都不同，避免重复感；
- **发布前必看同行爆款（2026-08-05 强制）**：每次发笔记前先用 `xhs-marketing.mjs reference/pick` 或搜索拉同行爆款，换不同选题结构写新文案（同行带去型 / 避坑干货型 / 场景共鸣型 / 被夸人设型…），禁止同一账号连续两篇同结构同话术；标题 ≤20 字、正文带 4-5 个话题、封面文字与标题呼应；
- **话题 SEO 公式（2026-08-06 强制，同城霸榜打法）**：正文话题**至少 3 个且必须与内容相关**（脚本会校验，不足会警告）。同城流量按「地域词 + 行业词 + 场景/人群词 + 同行爆款话题」组合，像 SEO 优化一样卡同城关键词：
  - 地域词：成都 / 双流 / 成都探店（放前面，吃同城流量池）；
  - 行业词：商务接待 / 商务KTV / SPA / 皮肤管理（用户搜索的核心词）；
  - 场景/人群词：商务宴请 / 接待客户 / 打工人 / 宝妈；
  - 同行话题：发前看 3-5 篇同行笔记带了哪些话题，蹭高浏览话题（如 #成都探店 #周末去哪玩）；
  - 示例（商K）：`#成都商务接待 #双流 #商务宴请 #KTV探店 #商务KTV #成都探店`；
  - 封面文字必须与标题/正文一致（脚本已强制每次从全新表单开始，避免旧封面残留造成"图文不符"）；
  - **话题必须与笔记内容相关**：每个话题都要能从标题/正文里找到依据（地域/行业/场景/痛点词），
    禁止 #测试、#定时发布、#日常、#随手拍 这类与内容无关的通用话题；
    脚本会拦截含"测试/定时发布"等词的话题并停止发布（2026-08-06 实测强制）；
- **文案永不重复（2026-08-06 强制铁律）**：每次发笔记必须换全新标题/结构/角度，禁止同文案二发。
  `xhs-publish.mjs` 内置发布历史库（`<userData>/xhs-publish-history.json`，已预置本账号全部历史笔记）：
  - 标题归一化后完全相同 → 直接拒绝发布；
  - 正文 2-gram 相似度 > 0.55 → 直接拒绝发布（实测 0.62 被拦截）；
  - 发布成功自动写入历史（`--industry` 标注行业），下次自动比对；
  - 发前必做：先看同行爆款换选题结构（同行带去型/避坑干货型/场景共鸣型/被夸人设型…轮换），
    同一账号禁止连续两篇同结构同话术；
- **防弹文件框（2026-08-05）**：脚本启动即拦截系统文件选择对话框（`Page.setInterceptFileChooserDialog`），即使误点"上传图片"也不会弹出 Windows 窗口；本地图片走 `DOM.setFileInputFiles` 直接注入；
- **表单自动填充（已验证可行）**：标题用 `input[placeholder*="标题"]`（触发 input/change），**标题必须 ≤20 字**（超长会被拦截）；正文用 `.tiptap.ProseMirror` + `document.execCommand('insertText', ...)`（换行自动成段落），话题直接写在正文末尾（`#话题`）；
- **可见范围**：在「更多设置」里点「公开可见」下拉 → 选「仅自己可见」（下拉必须用 CDP 真实鼠标坐标点击，`element.click()` 无效）；
- **发布按钮（已攻克 shadow DOM）**：新版创作页的发布条是自定义元素 `xhs-publish-btn`，按钮在内部 shadow DOM，通过 `document.querySelector('xhs-publish-btn')._sr.querySelector('button.bg-red')` 拿到红色「发布」按钮并点击。发布成功标志：发布页 URL 出现 `published=true`，然后到「笔记管理 → 仅自己可见」里确认。
- **提速要点**：全程一条 CDP 连接；「生成图片」若 `click()` 不触发，改用 CDP 真实鼠标点击；首页「最新笔记」有延迟，验证以「笔记管理」为准。

注意：**新创建的环境没有平台登录态**（会显示“登录后查看”），先用已登录的环境（或让用户在新环境里扫码登录），再执行以上脚本；发布评论前务必让用户确认话术内容。

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
带代理创建窗口的完整流程（云端令牌读取、代理创建、proxyId 绑定、验证）见 `references/create-window-with-proxy.md`。

## 海外版小红书（REDnote）发布（2026-08-08 新增）

海外版小红书 = rednote.com，创作者平台为 `creator.rednote.com`。已实测三窗口三篇图文发布成功，每篇约 15 秒。

```bash
# 本地图片发布（可多张 --image）
node scripts/xhs-rednote-publish.mjs <profileId> \
  --title "标题（≤20字）" --body-file %USERPROFILE%\body.txt \
  --image 图1.png --image 图2.png --image 图3.png \
  --visibility 公开可见 --confirm-public
```

- 默认可见范围跟随平台（rednote 默认「公开可见」；要私密传 `--visibility 仅自己可见`）；
- 正文直接写 `#话题`（至少 3 个且与内容相关）；
- 图片素材优先用 `capture-window.ps1` 截 MatrixFlow 主窗口 + `screenshot` 截浏览器实机画面；主窗口截图需打码左下角登录邮箱；
- 脚本自动处理：切「上传图文」→ 注入多图 → 填标题/正文 → 点发布（shadow DOM 按钮）→ 校验成功 → 记录防重复历史。

## 上传/读脚本扩展（2026-08-08）

- `upload <id|name[@tab]> <file1> [file2...]`：把本地文件直接注入页面 `input[type="file"]`（绕过 Windows 文件选择框），多文件一次注入；
- `eval <id|name[@tab]> @<file>`：从 UTF-8 文件读取 JS 执行，避免中文经管道/命令行乱码（推荐含中文的脚本用）。
