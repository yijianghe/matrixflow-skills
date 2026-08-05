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
| `open-batch <id1,id2,...>` | 并发批量打开多个环境（每批 3 个，速度快） |
| `create <name...> [--count N] [--prefix P]` | 新建环境（指纹克隆自第一个环境；--count 批量、--prefix 命名前缀） |
| `create <name> --proxy host:port[:user:pass]` | 新建环境并绑定代理（默认 SOCKS5，自动创建代理并关联） |
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

**发现页养号循环 v2（2026-08-05 重构，已实测验证）**：`scripts/xhs-feed-browse.mjs`

每篇笔记强制完整执行，全程拟真人、动作差异化：

1. 发现页随机选未浏览卡片，真实鼠标点击打开；
2. 检测笔记类型：视频 / 多图（1/N 页码）/ 单图；
3. **只滚动右侧内容面板 `.note-scroller`**（正文 + 评论区都在里面），详情打开后**绝对禁止滚动 window/背景瀑布流**；
4. 图文笔记停留 ≥ 30 秒（默认 30-45 秒随机），视频按播放进度等待（最长 40 秒）；
5. 多图笔记切图 1-3 次，每次用轮播快照（活跃圆点 / 大图地址 / transform）对比验证确实切换；
6. 滚评论区 2-4 次，滚到底自动停；随机点开 1-3 个“展开 N 条回复”（`.show-more`）看二级评论，展开后再点嵌套的“查看回复/条回复”看三级评论，用 `.note-scroller.scrollHeight` 增长验证；
7. 概率互动（默认：点赞 35%、收藏 20%），互动前检查 `like-active` / `collect-active` 状态，已互动不再点；用数字 +1 验证成功，数字 -1 自动恢复；
8. 每日安全上限：点赞 ≤ 30、收藏 ≤ 20（`--max-likes` / `--max-collects` 控制）；
9. 关闭笔记（`.close-circle`）并确认已关闭 → 滚发现页 500-800px → 下一篇；
10. 所有动作次数、间隔、停留时长全部随机，禁止每篇同一套动作模板。

```bash
node scripts/xhs-feed-browse.mjs <profileId> --rounds 6
```

- `--rounds N` — 浏览几篇笔记（默认 6）
- `--like-ratio 0.35` — 点赞概率（默认 0.35）
- `--collect-ratio 0.2` — 收藏概率（默认 0.2）
- `--max-likes 30` — 单次运行点赞上限（默认 30）
- `--max-collects 20` — 单次运行收藏上限（默认 20）
- `--min-dwell 30` — 每篇图文最短停留秒数（默认 30）
- 示例：`node scripts/xhs-feed-browse.mjs cmseose200emqpkjq82p387jj --rounds 8 --like-ratio 0.4`

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

## 差异化养号（防查重）

打标签/养号时所有动作都要随机差异化（脚本已内置）：
- 每个笔记的打开时间、停留时长、滚动次数、看评论区次数、切图次数各不相同；
- 随机点赞（约 35%）/收藏（约 15%），频率低且随机，绝不连续快速操作；
- 每次会话的节奏与上一会话不同。

## 发笔记（发布流程现状）

- **快速发布脚本（推荐，2026-08-05 新增）**：`scripts/xhs-publish.mjs` —— 一条 CDP 连接走完，默认文字转图片 + 每次随机选不同模板，实测发布流程 ~10-15 秒（同封面文案走 GPU 缓存秒出；全新文案首次生成 30-60 秒是平台 GPU 耗时，无法压缩）。
  ```bash
  node scripts/xhs-publish.mjs <profileId> \
    --title "标题（≤20字）" --cover "封面文字" --body-file D:\body.txt \
    [--template random|基础|美漫|插图|涂鸦|涂写|清新|边框|备忘|简约|光影|手写] \
    [--visibility 仅自己可见|公开可见|仅互关好友可见] \
    [--image <文件路径> | --image-dir <文件夹>] \
    [--draft]
  ```
  - 默认可见范围「仅自己可见」（私密）；要公开必须显式 `--visibility 公开可见`；
  - 正文用 `--body-file <path>` 传 UTF-8 文本文件最稳（避免命令行引号问题）；
  - **本地图片模式**：`--image <路径>` 指定单张图，或 `--image-dir <文件夹>` 指定目录；
    默认会从 `C:\Users\admin\Downloads`（下载目录）、桌面、`Documents\ShareX\Screenshots` 自动找第一张可用图片。
    **客户说"用配置图片"时，告诉客户图片放在哪：默认 `C:\Users\admin\Downloads` 或桌面，截图在 `C:\Users\admin\Documents\ShareX\Screenshots`；也可以直接把图片放进这些文件夹，脚本会自动读取。**
- **内容生成**：用 `reference` 拉爆款结构（标题/点赞/评论区高频问题）→ 改写种草文案（体验式、不硬广、引导私信）；
- **封面图（推荐原生文字生成图片，已验证 2026-08-05）**：打开创作平台发布页 → 点击「上传图片，或写文字生成图片」→ 选「文字配图」→ 输入封面文案 → 点「生成图片」→ 平台一次生成多套排版，选「基础」→ 点「下一步」直接带入发布表单。全程不需要本地素材/占位图。详见 `references/xhs-publish-native-text-to-image.md`；
- **模板随机（2026-08-05 新增）**：文字配图生成后平台会给 10 套模板（基础/美漫/插图/涂鸦/涂写/清新/边框/备忘/简约/光影/手写），脚本默认随机选一套并验证预览图确实切换；`--template <名字>` 可固定某套。每次发布模板都不同，避免重复感；
- **发布前必看同行爆款（2026-08-05 强制）**：每次发笔记前先用 `xhs-marketing.mjs reference/pick` 或搜索拉同行爆款，换不同选题结构写新文案（同行带去型 / 避坑干货型 / 场景共鸣型 / 被夸人设型…），禁止同一账号连续两篇同结构同话术；标题 ≤20 字、正文带 4-5 个话题、封面文字与标题呼应；
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
