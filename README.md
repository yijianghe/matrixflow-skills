# MatrixFlow Skills —— AI 接管指纹浏览器的完整技能包

让 AI（Codex 等 Agent）直接接管 [MatrixFlow 指纹浏览器](https://browser.lingjingxia.com) 的窗口，
完成：**窗口管理、真人式浏览、小红书养号/发笔记/截流/私信、Automa 工作流、窗口同步**。
内置中文 SOP + Node.js 零依赖脚本，开箱即用。

> 亮点：发笔记已攻克新版创作页（文字转图片封面、仅自己可见、定时发布、文案永不重复），
> 小红书引流陪跑 SOP 覆盖 100+ 行业。

> 📖 从零开始安装 Codex + 配置 DeepSeek API + 安装浏览器 + 配置本技能：
> 完整教程见 [TUTORIAL.md](TUTORIAL.md)。

---

## 30 秒上手

```bash
# 0. 新电脑第一步：环境自检（每个 FAIL/WARN 都带修复指引）
node scripts/mf-browser.mjs doctor

# 1. 确认 MatrixFlow 应用在运行（本机桌面应用，技能通过本地 API 控制）
node scripts/mf-browser.mjs status

# 2. 列出运行中的窗口（环境）
node scripts/mf-browser.mjs list

# 3. 打开一个窗口
node scripts/mf-browser.mjs open <profileId> https://www.xiaohongshu.com

# 4. 发一篇小红书笔记（默认：文字转图片封面 + 仅自己可见 + 立即发布）
node scripts/xhs-publish.mjs <profileId> \
  --title "下班后的1小时，我去干了这件事" \
  --cover "下班后1小时" \
  --body-file body.txt
```

正文文件 `body.txt` 示例（**话题必须 ≥3 个且与内容相关**，同城流量带地域词）：

```text
加班三个月，肩颈比 KPI 还硬，下班只想瘫着。
同事拉我去做了次足疗+肩颈，说比睡觉管用。
环境干净，师傅手法到位，按到肩颈那一下差点睡着。
不推销不办卡，做完就走。
坐标成都双流，需要的姐妹私我发位置～
#成都足疗 #双流 #按摩放松 #肩颈放松 #下班后的别样生活 #成都探店
```

---

## 安装教程

### 方式一：复制到 Codex 技能目录（推荐）

把 `matrixflow-browser-control` 文件夹放进 Codex 的技能目录，重启 Codex 即生效：

```bash
# Windows（PowerShell）
Copy-Item -Recurse matrixflow-browser-control "$env:USERPROFILE\.codex\skills\"

# macOS / Linux
cp -r matrixflow-browser-control ~/.codex/skills/
```

### 方式二：克隆整个仓库

```bash
git clone https://github.com/yijianghe/matrixflow-skills.git ~/.codex/skills/matrixflow-skills
```

### 方式三：其它 AI 工具 / 纯手工

- 支持 Codex 技能格式的工具：按方式一安装；
- 其它 Agent：把 `matrixflow-browser-control/SKILL.md` 作为工具说明注入，并允许 Agent 执行
  `scripts/mf-browser.mjs` / `xhs-publish.mjs` / `xhs-marketing.mjs`；
- 纯手工：直接 `node scripts/mf-browser.mjs <命令>` 即可（见命令速查）。

### 使用前提

- 本机已安装并登录 [MatrixFlow 桌面应用](https://browser.lingjingxia.com)（本地 API `127.0.0.1:19527`）；
- **客户端已登录账号**：新建/删除环境、绑定代理走云端，未登录会失败（用 `doctor` 自检）；
- Node.js ≥ 22（脚本只用内置 `fetch` + `WebSocket`，**零 npm 依赖**）；
- 发笔记需要小红书账号已在浏览器窗口登录（创作服务平台）。

---

## 一、窗口（环境）管理

```bash
node scripts/mf-browser.mjs create "小红书1号"              # 新建窗口（指纹克隆）
node scripts/mf-browser.mjs create "演讲词" --proxy "dc.decodo.com:10115:user:pass"  # 新建+绑代理
node scripts/mf-browser.mjs create "小红书1" "小红书2" --proxy "host:port:user:pass"  # 一次建多个+同一代理
node scripts/mf-browser.mjs create "批量号" --count 10 --prefix xhs   # 批量创建
node scripts/mf-browser.mjs open-batch id1,id2,id3         # 并发打开（每批3个）
node scripts/mf-browser.mjs open <id|name>                 # 打开窗口
node scripts/mf-browser.mjs close <id|name>                # 关闭窗口
node scripts/mf-browser.mjs delete <id|name>               # 删除窗口
node scripts/mf-browser.mjs list                           # 列出运行中的窗口
```

代理自动验证：打开 `https://api.ip.sb/geoip` 看出口 IP 是否已切换。

---

## 二、浏览器控制（CDP 直连，速度快）

```bash
node scripts/mf-browser.mjs navigate <id> <url>            # 导航（自动等待加载）
node scripts/mf-browser.mjs text <id> [maxChars]           # 提取页面文本
node scripts/mf-browser.mjs click <id> <cssSelector>       # 点击（真实鼠标事件）
node scripts/mf-browser.mjs type <id> <cssSelector> <text> # 输入文字
node scripts/mf-browser.mjs scroll <id> [deltaY]           # 滚动
node scripts/mf-browser.mjs eval <id> '<js>'               # 执行 JS（可传 - 从 stdin 读）
node scripts/mf-browser.mjs screenshot <id> <file.png>     # 截图
node scripts/mf-browser.mjs pages <id>                     # 列出标签页
node scripts/mf-browser.mjs run <id> '<steps-json>'        # 单连接批量执行多步（最快）
```

多标签页定位：用 `profileId@网址片段`（如 `cmse…@wd=小红书`）而不是序号。

---

## 三、小红书发笔记（核心能力，已攻克新版创作页）

### 快速发布脚本 `xhs-publish.mjs`

```bash
node scripts/xhs-publish.mjs <profileId> \
  --title "标题（≤20字）" \
  --cover "封面文字" \
  --body-file D:\正文.txt \
  [--template random|基础|美漫|插图|涂鸦|涂写|清新|边框|备忘|简约|光影|手写] \
  [--visibility 仅自己可见|公开可见|仅互关好友可见] \
  [--image <图片路径> | --image-dir <文件夹>] \
  [--schedule "YYYY-MM-DD HH:mm" | "明天 10:00" | "后天 10:00"] \
  [--industry 行业名] \
  [--draft]
```

### 发布规则（内置强制，2026-08-06）

| 规则 | 说明 |
| --- | --- |
| 默认发布 | **仅自己可见 + 立即发布 + 不定时**；只有显式传 `--schedule` 才定时；只有显式 `--visibility 公开可见` 才公开 |
| 标题 | ≤ 20 字，超出直接拦截 |
| 话题 | **必须 ≥3 个且与内容相关**，不足直接拦截不发；含"测试/定时发布"等无关词也拦截 |
| 文案去重 | 内置历史库：标题相同或正文相似度 >55% 直接拒绝，发布成功自动入库（历史在 `<userData>/xhs-publish-history.json`） |
| 定时发布 | 平台要求**至少 1 小时后**（脚本自动校验）；开关/日期/小时自动设置，分钟用平台默认（当前+30 分钟），偏差 >3 分钟会警告 |
| 封面 | 默认平台原生"文字转图片"，每次随机换模板；`--image` 支持本地图片（默认从 Downloads/桌面/ShareX 截图目录找） |
| 图文一致 | 每次从全新表单开始（残留草稿自动退出），封面文字=标题核心词，杜绝图文不符 |

### 同城流量话题公式（SEO 式霸榜）

```text
#地域词（成都/双流/成都探店） + #行业词（商务接待/SPA/足疗） + #场景/人群词（商务宴请/接待客户/打工人） + #同行爆款话题
```

示例（商K）：`#成都商务接待 #双流 #商务宴请 #KTV探店 #商务KTV #成都探店`

---

## 四、小红书引流陪跑（完整流程）

### 1) 打标签（养号期 7-14 天）

```bash
node scripts/xhs-marketing.mjs <id> tag '成都 spa' '缓解焦虑' '探店' --notes 5
```

### 2) 真人式养号（差异化、防查重）

```bash
node scripts/xhs-feed-browse.mjs <profileId> --rounds 6 --like-ratio 0.35 --collect-ratio 0.2
```

详情页只滚右侧内容面板、图文停留 30-45 秒、随机点赞收藏、展开二级/三级评论、概率互动、安全阈值（赞≤30/藏≤20/天）。

### 3) 选爆款 + 看同行（发笔记前必做）

```bash
node scripts/xhs-marketing.mjs <id> reference '成都 spa' --top 5
```

### 4) 评论区截流（找有需求的客户）

```bash
# 扫描同行评论区，自动分辨"求地址/求推荐/问价格"的意向客户（支持展开二级/三级评论）
node scripts/xhs-marketing.mjs <id> scan '成都 spa' --top 5 --city 成都

# 给某条意向评论种草式回复
node scripts/xhs-marketing.mjs <id> reply '成都 spa' --to '姐妹这家在哪呀' --comment '我上次去的还不错，私我发你位置～'
```

### 5) 私信（看未读私信 / 回复）

```bash
# 打开网页版消息页，读取会话/未读私信
node scripts/xhs-marketing.mjs <id> inbox
# 回复：在消息页用 mf-browser click/type 操作（Agent 按 SKILL.md 的私信 SOP 执行）
```

### 6) 引流建议（留钩子 / 话术）

- **评论钩子**：`需要的姐妹私我发位置～` / `搜"XX"看第一篇就是` / `评论区扣1，我私你资料`；
- **私信承接**：先聊两句（纯客服）→ 给正当理由（"点我瞬间看细节图"）→ 再引导主页/置顶；
- **禁止**：私信第一句甩微信/链接、评论区出现手机号、同话术刷屏（必挂）；
- **转化路径**：评论区种草 → 主页置顶/收藏夹（放门店信息）→ 私信承接；
- **每日红线**：截流 ≤5 条、评论 ≤15 条、秒赞秒评是雷区、同城流量必带地域词。

完整 SOP 见 `references/xhs-leadgen.md`（SPA/商K/论文/私域资料等案例）和
`references/xhs-industry-100.md`（100+ 行业速查：卖产品/卖货/卖服务/卖知识）。

---

## 五、Automa 工作流 / RPA

```bash
node scripts/mf-browser.mjs automa-open <workflowId>       # 打开 Automa 设计器
node scripts/mf-browser.mjs workflow-create <workflowId> [name]
node scripts/mf-browser.mjs workflow-list
```

---

## 六、窗口同步器

保存窗口+标签页布局为快照、一键恢复、跨设备导入导出。本地 API：
`POST/GET /api/v1/window-sync/snapshots`、`POST .../restore`、`DELETE .../:id`。

---

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `status` / `list` | 应用状态 / 运行中的窗口 |
| `create <name> [--count N] [--proxy ...]` | 创建窗口（批量/绑代理） |
| `open` / `close` / `delete` / `open-batch` | 打开 / 关闭 / 删除 / 批量打开 |
| `navigate` / `title` / `text` | 导航 / 标题 / 正文提取 |
| `click` / `type` / `scroll` / `eval` / `screenshot` | 点击 / 输入 / 滚动 / JS / 截图 |
| `pages` / `profileId@片段` | 多标签管理 |
| `run` | 单连接批量执行 |
| `xhs-publish.mjs` | 发笔记（文字转图片/定时/去重/话题强制） |
| `xhs-feed-browse.mjs` | 发现页真人养号循环 |
| `xhs-marketing.mjs` | tag/pick/scan/reply/reference/full/inbox |
| `human-browse.mjs` | 通用真人浏览 |
| `automa-open` / `workflow-*` | Automa 工作流 |

## 速度说明

- 直连窗口级 CDP WebSocket，跳过浏览器级往返；
- 所有等待用轮询（readyState / 元素出现），不用固定 sleep；
- 发笔记实测：封面走缓存时整流程 ~15-20 秒；全新封面首次生成需等平台 GPU 30-60 秒（平台硬耗时）；
- 创建带代理窗口实测约 0.5 秒，出口 IP 验证约 8 秒。

## 常见问题（FAQ）

**Q: 换新电脑后"创建窗口失败"？** 先运行 `node scripts/mf-browser.mjs doctor`。绝大多数原因是 **MatrixFlow 客户端没登录**——新建/删除/绑代理都要走云端；请先登录账号，再把 `[WARN] 云端账号未登录` 一项跑到 `[PASS]`。首次使用还需要至少一个已存在的环境作为指纹模板。
**Q: 某些客户端版本本地接口不支持新建/删除窗口？** 脚本已内置云端自动回退（本地接口失败自动改走云端），无需处理；前提是客户端已登录。若 `doctor` 提示云端令牌未找到但已登录，用管理员身份重新打开终端再运行。
**Q: 换新电脑后提示 401 / Token 缺失？** 在 MatrixFlow 客户端"设置 → API 文档"开启本地 API，把 Token 写入 `%APPDATA%\@matrixflow\desktop\local-api-token.txt`（或用环境变量 `MF_LOCAL_API_TOKEN`）。
**Q: 提示 API 不可达？** 先启动 MatrixFlow 应用，再 `status`。
**Q: Token 缺失？** 应用"设置 → API 文档"复制 Token，或确认 `local-api-token.txt` 存在。
**Q: 发笔记被"文案重复"拦截？** 说明与历史笔记相似，换角度/换结构写全新文案（这是故意的）。
**Q: 话题不足被拦截？** 正文至少写 3 个与内容相关的话题（同城带地域词）。
**Q: 定时时间被拒？** 定时必须至少 1 小时后，用 `--schedule "明天 10:00"` 这类未来时间。
**Q: 窗口没反应？** 先 `open` 再操作；多标签用 `profileId@网址片段` 定位。
**Q: 图片配文案怎么传？** 把图片完整路径给 Agent（如 `C:\Users\admin\Documents\xx.png`），或放进 Downloads/桌面后说文件名。

## 更新日志

- **2026-08-06**：新增 `doctor` 环境自检命令（新电脑部署第一步）；创建窗口失败原因定位（未登录/无指纹模板/Token 缺失）；云端令牌改为 PowerShell 读取 Windows 凭据管理器，任何机器无需 keytar；运行检测兼容不同客户端版本；新建/删除环境自动云端回退。
- **2026-08-06**：发笔记规则强化——默认私密立即发布；话题 ≥3 强制；文案永不重复（历史库双拦截）；定时至少 1 小时；同城 SEO 话题公式；100+ 行业速查库；私信 inbox 命令；评论二级/三级展开。
- **2026-08-05**：xhs-publish.mjs 快速发布（文字转图片+随机模板+定时）；养号循环 v2（只滚详情容器/30-45s/概率互动）；全行业 SOP 框架。

## 许可

MIT License。本项目与 MatrixFlow 官方无隶属关系，为第三方技能。
