# Facebook 表格自动发帖（Automa + MatrixFlow）

一套「表格驱动」的 Facebook 发帖方案：文案和图片路径写在表格里，
每个窗口发一行，发完自动关闭，再开下一个窗口发下一行。

## 文件清单

| 文件 | 作用 |
| --- | --- |
| `fb-publish-queue.csv` | 发帖队列表格（文案 + 图片路径 + 状态） |
| `facebook-publish.automa.json` | Automa 工作流（窗口内执行：改中文 → 打开发布框 → 等注入 → 设公开 → 发帖） |
| `fb-table-run.mjs` | 编排脚本（读表 → 开窗 → 注入图文 → 等发完 → 关窗 → 下一行） |

## 一、表格怎么用

列说明（`fb-publish-queue.csv`）：

| 列 | 含义 |
| --- | --- |
| seq | 行号（从 1 开始） |
| window_id | MatrixFlow 窗口的 profileId（在应用里窗口列表可复制） |
| post_text | 帖子文案（支持换行，用英文双引号包住） |
| image_path | 配图绝对路径（推荐用产品图目录 `fb-images/product/` 里的图） |
| status | `待发布` / `已发布` / `失败`（编排脚本只处理「待发布」） |

想用谷歌表格：
1. 打开 [sheets.google.com](https://sheets.google.com)，新建表格；
2. 文件 → 导入 → 上传 `fb-publish-queue.csv`；
3. 编辑完导出：文件 → 下载 → CSV，覆盖 `D:\zhiwenliulanqi\fb-publish-queue.csv`；
4. 表格里有换行的文案，导出 CSV 后格式不会丢（标准 CSV 引号规则）。

## 二、Automa 工作流怎么装

1. 打开 MatrixFlow 的一个窗口，确保装了 Automa 扩展（v1.30+）；
2. 点 Automa 图标 → 工作流 → 导入 → 选择 `facebook-publish.automa.json`；
3. 工作流名会显示「Facebook 表格发帖」。

工作流逻辑（全部实测过的选择器）：
- 打开 `https://www.facebook.com/?locale=zh_CN` 强制中文界面；
- 从页面 `localStorage.mf_post` 读文案和图片路径；
- 点「分享你的新鲜事」打开发布框（中/英/韩/意多语言兜底）；
- 标记 `mf_composer_ready=1`，等编排脚本注入图片和文本；
- 内容就绪后：设公开（多语言）→ 点发帖（多语言）→ 标记 `mf_done=published`。

## 三、怎么跑（完整流程）

```bash
# 1. 先编辑表格，把要发的行 status 设为「待发布」
# 2. 运行编排脚本（MatrixFlow 应用需在运行、已登录）
node D:\zhiwenliulanqi\fb-table-run.mjs D:\zhiwenliulanqi\fb-publish-queue.csv
```

编排脚本会逐行：
1. 打开该行 window_id 的窗口；
2. 把文案和图片路径写入窗口页面的 localStorage；
3. 提示你在**窗口的 Automa 面板**点一次运行「Facebook 表格发帖」；
4. Automa 打开发布框后，编排脚本自动注入图片和文本（CDP，可靠）；
5. Automa 设公开并点发帖，标记完成；
6. 编排脚本检测到完成 → 关闭窗口 → 处理下一行。

> 一次开几个窗口由你控制：想一次跑 2-3 行，就开 2-3 个窗口分别运行；
> 每个账号发满 2-3 篇就换账号（表格里每行 window_id 指向不同窗口）。

## 四、关键设计（为什么这样能跑通）

- **Cloak 内核屏蔽 CDP 合成鼠标点击**：Automa 自带的「点击元素」模块
  用的是 CDP 鼠标，在 MatrixFlow 里会失效；所以工作流里**所有点击都用
  页面 JS 合成事件**（pointerdown/mousedown/pointerup/mouseup/click）；
- **图片注入和文本输入用 CDP**：`DOM.setFileInputFiles` 注入图片、
  `Input.insertText` 输入文案（这两者不受内核屏蔽，实测有效）；
- **Automa 与编排脚本通过 localStorage 同步状态**：composer_ready /
  content_ready / mf_done，避免复杂的 Automa 变量传递；
- **强制中文**：`?locale=zh_CN` 参数切换界面语言，不用进设置页；
- **每行一个窗口**：发完即关，符合「2-3 个发完关闭继续」的规则。

## 五、注意事项

- Facebook 自动化有风控：**一个账号一天最多 2-3 篇**，篇与篇间隔 2.5 秒以上；
- 文案每次要换角度（参考 `skill 的 references/facebook-leadgen.md` 模板改）；
- 配图必须用产品图（`fb-images/product/`），不要发无关截图；
- 窗口在运行 Automa 工作流前**保持可见**（方便你确认状态）；
- 发失败时 `mf_done` 会写 `error:xxx`（no-data/composer/content-timeout/post），
  编排脚本会打印出来，对应检查：
  - `no-data`：localStorage 没写入（编排脚本没注入或窗口页面不对）；
  - `composer`：发布框没打开（检查窗口是否在 facebook.com）；
  - `content-timeout`：图片/文本没注入（检查图片路径是否存在）；
  - `post`：发帖按钮点击后发布框没关（多为图片未上传完，可重跑）。

## 六、常见问题

- **Automa 面板打不开 / 安装不了**：换一个已装 Automa 的窗口，
  或参考 skill 的排错（`doctor` 自检）；
- **表格中文乱码**：CSV 必须是 UTF-8；谷歌表格导出时选「CSV（当前工作表）」；
- **窗口掉线**：表格对应 window_id 的账号需已登录 Facebook；
- **token 问题**：本方案不需要 token（关窗由编排脚本用本地 API 完成，
  token 自动从应用读取）。

## 2026-08-13 实测结论（重要更新）

- **主推 b-table-auto.mjs**（不再依赖 Automa 扩展）：
  
ode fb-table-auto.mjs fb-publish-queue.csv [--window <id>] [--row N] [--dry]
  读表 → 开窗 → 导航 Facebook → 调 fb-post.mjs 发帖（图文+公开）→ 关窗 → 下一行；
- **已实测跑通**：92 号窗口完整流程约 1 分钟/篇，帖子真实发布成功
  （活动日志确认：文案 + 产品图 + 公开）；
- **Automa 扩展自动触发在本机 Cloak 内核下报错**（工作流能导入、能显示，
  执行引擎报 undefined.split），acebook-publish.automa.json 保留可导入，
  但自动触发待 Automa 版本兼容后再用；
- 规则不变：一个账号一天 2-3 篇，发完关闭窗口再开下一个。
