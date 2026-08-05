# 完整安装与使用教程

**Codex（AI 助手） + DeepSeek（大模型 API） + MatrixFlow（指纹浏览器） + 小红书引流技能**

本教程从零开始，带你把整套环境装好并用起来：AI 助手能直接接管指纹浏览器窗口，
完成网页操作、小红书养号/发笔记/评论区截流/私信等全套引流工作。

---

## 第一部分：安装 Codex（AI 助手）

Codex 有两种形态，任选其一：

### 方式 A：桌面版（推荐，有图形界面）

1. 到 Codex 官网（https://openai.com/codex 或对应下载页）下载 Windows 桌面版安装包；
2. 双击安装，登录 OpenAI 账号（或后续用 DeepSeek 等第三方 API，见第二部分）；
3. 安装完成后打开，会看到聊天/任务界面，这就是你指挥 AI 干活的地方。

### 方式 B：命令行版（CLI）

```bash
# 需要先装 Node.js >= 22（https://nodejs.org）
npm install -g @openai/codex

# 验证
codex --version
```

### 验证安装

```bash
codex --version   # CLI 版本号
# 桌面版直接打开应用即可
```

> 提示：本教程的技能脚本只依赖 Node.js 内置能力（fetch + WebSocket），不装任何 npm 包。

---

## 第二部分：配置 DeepSeek API（给 Codex 接大模型）

### 2.1 先拿 DeepSeek API Key

1. 打开 DeepSeek 开放平台：https://platform.deepseek.com
2. 注册/登录 → 「API Keys」→ 创建新 Key（格式：`sk-xxxxxxxx`）；
3. 充值少量余额（DeepSeek 很便宜）；
4. 记住两个模型名：`deepseek-chat`（通用对话，推荐）、`deepseek-reasoner`（推理增强）。

### 2.2 重要：为什么不能直接改 base_url（必读）

从 2026 年起，**Codex 强制使用 OpenAI 的 Responses API**（请求发到 `/v1/responses`），
而 DeepSeek 官方接口只有 Chat Completions API（`/v1/chat/completions`）。
**直接在 `config.toml` 里写 `base_url = "https://api.deepseek.com/v1"` 会报 400/404。**

解决办法有两种，任选：

### 方案 A：用 DeepSeek 官方一键配置脚本（推荐，最简单）

DeepSeek 官方提供了接入 Codex 的一键脚本，会自动完成全部配置：

1. 打开官方文档：https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/
2. 按页面提示下载并运行一键配置脚本（脚本会自动修改 `~/.codex/config.toml`）；
3. 运行前先设置环境变量 `DEEPSEEK_API_KEY`（Windows PowerShell）：

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的key"
```

### 方案 B：本地代理翻译协议（codex-relay / 官方支持的工具）

在本地跑一个小代理，把 Codex 的 Responses 请求翻译成 DeepSeek 的 Chat 请求：

```bash
# 安装代理（任选一个开源工具）
# codex-relay: https://github.com/MetaFARS/codex-relay
# deepseek-responses-proxy: https://github.com/holo-q/deepseek-responses-proxy

# 启动代理（示例，端口自定）
codex-relay --upstream https://api.deepseek.com --api-key sk-你的key
```

然后编辑 `~/.codex/config.toml`（Windows 是 `C:\Users\你的用户名\.codex\config.toml`）：

```toml
model = "deepseek-chat"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:8787/v1"   # 本地代理地址（按代理实际端口）
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

如果代理提示需要模型元数据（`Model metadata not found`），按代理工具输出补上
`model_properties`（上下文长度、是否支持推理等），或直接用 `codex-relay --print-config` 生成。

### 2.3 验证 DeepSeek 配置

```bash
# CLI 方式：直接开一个对话，看是否用 deepseek-chat 回答
codex "你好，用一句话介绍你自己"

# 桌面版：设置里选模型 provider = DeepSeek，新建对话测试
```

> 模型选择建议：日常任务用 `deepseek-chat`；需要深度思考/复杂推理用 `deepseek-reasoner`。
> 如果某个 reasoning 档位不生效（桌面版可能只显示部分档位），在 config.toml 里手动写
> `model_reasoning_effort = "high"` 再重启。

---

## 第三部分：安装 MatrixFlow 指纹浏览器

1. 打开官网：https://browser.lingjingxia.com
2. 下载 Windows 安装包（文件名类似 `MatrixFlow Setup x.x.x.exe`），双击安装；
3. 打开应用，用你的账号登录；
4. 在「环境」里创建窗口（每个窗口 = 一个独立浏览器指纹）：
   - 命名（如"小红书1号"）
   - 可绑定代理（IP/端口/账号密码），每个窗口独立 IP 防关联；
5. 点「打开」启动窗口，窗口会弹出真实的 Chromium 浏览器。

### 验证本地 API

技能通过本地 API（`127.0.0.1:19527`）控制浏览器。安装技能后运行：

```bash
node scripts/mf-browser.mjs status
# 输出 appRunning: true 即正常
```

> 提示：应用「设置 → API 文档」里有 Token（本地 API 鉴权用），技能会自动读取。

---

## 第四部分：安装小红书引流技能（matrixflow-browser-control）

### 4.1 方式一：复制到 Codex 技能目录（推荐）

```powershell
# Windows（PowerShell）
Copy-Item -Recurse matrixflow-browser-control "$env:USERPROFILE\.codex\skills\"

# macOS / Linux
cp -r matrixflow-browser-control ~/.codex/skills/
```

复制后**重启 Codex（或新开一个会话）**，技能即被自动识别。

### 4.2 方式二：克隆整个仓库

```bash
git clone https://github.com/yijianghe/matrixflow-skills.git ~/.codex/skills/matrixflow-skills
```

### 4.3 方式三：其它 AI 工具 / 纯手工

- 其它 Agent：把 `matrixflow-browser-control/SKILL.md` 作为工具说明注入，并允许执行
  `scripts/` 下的 Node.js 脚本；
- 纯手工：直接在终端运行 `node scripts/mf-browser.mjs <命令>`。

### 4.4 验证安装

```bash
cd matrixflow-browser-control/scripts
node mf-browser.mjs doctor          # 新电脑第一步：环境自检，每一项 FAIL/WARN 都带修复指引
node mf-browser.mjs status          # 应用在运行？
node mf-browser.mjs list            # 能看到你的窗口？
node mf-browser.mjs open <窗口ID> https://www.xiaohongshu.com   # 打开小红书
```

### 4.5 换新电脑特别说明（重要）

在**另一台电脑**上装好技能后，先跑 `doctor` 自检，按提示逐项处理：

1. **客户端未登录**（最常见）：新建/删除窗口、绑定代理都要走云端。打开 MatrixFlow 客户端 → 登录你的账号 → 重新 `doctor`，直到"云端账号已登录"显示 `[PASS]`。
2. **本地 API Token 未配置**：客户端"设置 → API 文档"里开启本地 API，把 Token 写入 `%APPDATA%\@matrixflow\desktop\local-api-token.txt`，或用环境变量 `MF_LOCAL_API_TOKEN`。
3. **当前没有任何环境**：首次使用先在客户端手动创建一个窗口，之后 `create` 才能克隆指纹批量新建。
4. **Node.js 版本过低**：装 Node.js 22+。

> 常见误区：在别的电脑上直接执行 `create` 失败，不是脚本坏了，而是**客户端没登录或没有指纹模板**。先 `doctor` 再操作。

---

## 第五部分：使用教程

### 5.1 浏览器基础控制

```bash
node scripts/mf-browser.mjs navigate <窗口> https://example.com   # 导航
node scripts/mf-browser.mjs text <窗口>                            # 读页面文字
node scripts/mf-browser.mjs click <窗口> 'button.submit'           # 点击
node scripts/mf-browser.mjs type <窗口> 'input[name=q]' 关键词     # 输入
node scripts/mf-browser.mjs screenshot <窗口> shot.png             # 截图
node scripts/mf-browser.mjs pages <窗口>                           # 列出标签页
```

多标签定位：`<窗口ID>@网址片段`（如 `cmse…@wd=小红书`）。

### 5.2 发小红书笔记（核心）

```bash
node scripts/xhs-publish.mjs <窗口ID> \
  --title "下班后的1小时，我去干了这件事" \
  --cover "下班后1小时" \
  --body-file %USERPROFILE%\正文.txt \
  [--template random] \
  [--schedule "明天 20:00"] \
  [--image C:\图片.png] \
  [--visibility 公开可见]
```

**发布规则（内置强制）**：
- 默认：**仅自己可见 + 立即发布 + 不定时**；公开/定时都要显式传参；
- 标题 ≤ 20 字；话题 ≥ 3 个且与内容相关（不足直接拦截）；
- 文案永不重复：标题相同或正文相似 >55% 自动拒绝；
- 定时至少 1 小时后；封面默认文字转图片、随机模板。

正文文件示例（话题按同城 SEO 组合）：

```text
做商务接待三年，最怕客户来之前问"晚上去哪"。
上个月客户来双流谈合作，定了这家：包间私密不吵，管家把酒水餐食全安排好。
坐标成都双流，需要的老板私我发位置～
#成都商务接待 #双流 #商务宴请 #KTV探店 #商务KTV #成都探店
```

### 5.3 养号 + 打标签

```bash
# 打标签：搜索关键词并真人浏览（训练推荐算法）
node scripts/xhs-marketing.mjs <窗口ID> tag '成都 spa' '缓解焦虑' --notes 5

# 发现页真人养号（差异化浏览、概率互动、安全阈值）
node scripts/xhs-feed-browse.mjs <窗口ID> --rounds 6
```

### 5.4 评论区截流（找客户 + 回复）

```bash
# 扫描同行评论区，自动分辨"求地址/求推荐/问价格"的意向客户（含二级/三级评论）
node scripts/xhs-marketing.mjs <窗口ID> scan '成都 spa' --top 5 --city 成都

# 给意向客户种草式回复
node scripts/xhs-marketing.mjs <窗口ID> reply '成都 spa' \
  --to '求地址' --comment '我上次去的那家还不错，私我发你位置～'
```

### 5.5 私信（看未读 + 回复）

```bash
# 打开消息页，读取未读私信/会话
node scripts/xhs-marketing.mjs <窗口ID> inbox
```

回复私信在消息页用 `click`/`type` 操作，话术遵循「先聊两句 → 给正当理由 → 引导主页」。

### 5.6 引流建议（留钩子 / 话术）

- **评论钩子**：`需要的姐妹私我发位置～` / `搜"XX"看第一篇就是` / `评论区扣1，我私你资料`；
- **私信承接**：先正常聊（"有的哦，你要哪个呀？"）→ 给正当理由（"点我瞬间看细节图"）→ 再引导；
- **红线**：私信第一句不甩微信、评论区不放手机号、同话术不刷屏、每日截流 ≤5 条；
- **同城 SEO**：话题带「地域 + 行业 + 场景 + 同行话题」，像 SEO 卡关键词一样打同城霸榜。

完整行业 SOP：`references/xhs-leadgen.md`、`references/xhs-industry-100.md`（100+ 行业速查）。

---

## 常见问题（FAQ）

**Q: DeepSeek 直连报 400/404？** Codex 用 Responses API，DeepSeek 只有 Chat API，必须用官方一键脚本或本地代理（见第二部分）。
**Q: 换新电脑后"创建窗口失败"？** 先运行 `node scripts/mf-browser.mjs doctor` 自检。绝大多数原因是 MatrixFlow 客户端没登录（新建/删除/绑代理走云端），登录后重试；若提示"没有可用指纹模板"，先在客户端手动创建一个窗口。
**Q: 技能提示 API 不可达？** 先启动 MatrixFlow 应用，再 `status`。
**Q: 提示 401 / Token 缺失？** 在客户端"设置 → API 文档"开启本地 API 并把 Token 写入 `local-api-token.txt`（或设 `MF_LOCAL_API_TOKEN`）。
**Q: 发笔记被"话题不足"拦截？** 正文至少写 3 个与内容相关的话题（同城带地域词）。
**Q: 发笔记被"文案重复"拦截？** 说明和已发笔记相似，换角度/换结构写全新文案（这是防重复保护）。
**Q: 定时被拒？** 定时必须至少 1 小时后，用"明天 20:00"这类未来时间。
**Q: 图片配文案怎么传？** 把图片完整路径发给 AI（如 `%USERPROFILE%\Documents\xx.png`），或放进下载目录/桌面后说文件名。
**Q: 多标签窗口点错？** 用 `窗口ID@网址片段` 锁定目标标签页。

## 安全提示

- 每个账号建议独立窗口 + 独立代理 IP，防止平台关联；
- 新号前 3 天只浏览不评论；互动频率控制在安全阈值内（赞 ≤30/藏 ≤20/评 ≤15 每天）；
- 引流话术不带微信/手机号，用"私我/主页置顶/瞬间"承接；
- 本技能为第三方工具，与 MatrixFlow、小红书官方无隶属关系，请合规使用。

## 更新日志

- 2026-08-06：新增 `doctor` 环境自检命令（新电脑部署第一步）；创建窗口失败原因定位与修复指引（未登录/无指纹模板/Token 缺失）；云端令牌改为 PowerShell 读取 Windows 凭据管理器，任何机器无需 keytar。
- 2026-08-06：完整教程初版（Codex + DeepSeek + MatrixFlow + 技能安装使用）。
