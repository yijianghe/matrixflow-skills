# Facebook 网页元素结构参考（2026-08-13 实测）

> 用途：写 Automa 自动化工作流 / 改自动化脚本时，直接照这份元素表写选择器和判断条件。
> 所有选择器均在 MatrixFlow 指纹浏览器（Chromium 146 / Cloak 内核）实测验证。
> 多语言界面（韩文/意大利文/英文）均已实测，见各节「多语言」。

## 0. 核心原则（踩坑总结）

1. **发布框是 contenteditable div，不是 textarea**：旧工作流里的 `textarea.textbox`
   选择器已失效，必须用 `div[contenteditable="true"]`；
2. **Cloak 内核屏蔽 CDP 合成鼠标**（v1.15+）：`Input.dispatchMouseEvent` 的
   pressed/released 到不了页面，必须用页面内 JS 合成事件（见 `scripts/fb-input.mjs`）；
3. **Facebook 有隐藏副本**：同一弹窗在 DOM 里出现 2 份（真实 + 空副本），
   必须用「可见层判定」（elementFromPoint 命中自身）或「有 contenteditable / 有图」区分；
4. **radio input 藏在屏幕外**：公开选项的单选 input 在 x > innerWidth 的位置，
   必须点样式化可见圆点（20-40px 方形）；
5. **Reels 引导弹窗**会叠在发布框上，处理 = 移除弹窗 + 移除残留全屏遮罩；
6. **发布按钮有禁用副本**：要过滤 `aria-disabled="true"`。

---

## 1. 登录状态检测

| 状态 | 判断方法 |
| --- | --- |
| 未登录 | `form[data-testid="royal_login_form"]` 或 `#loginform` 或 `input[name="email"]` / `input[name="pass"]` 存在 |
| 已登录 | `div[role="feed"]` 或 `[data-testid="current_account_switcher"]` 存在；URL 为 `facebook.com/` |
| 检查点/验证 | URL 含 `/checkpoint`；标题含「确认你的身份 / Checkpoint / Security Check」 |
| 锁定 | 标题含「账号已被锁定 / Account Temporarily Unavailable / locked」 |

## 2. 首页发布入口（点它打开发布框）

元素：`div[role="button"]`（或 `[role="button"]`），文本包含以下关键词，且
`width 100~900`、`bottom>0`、`top<innerHeight`。

| 语言 | 关键词 |
| --- | --- |
| 中文 | `分享你的新鲜事` / `分享想法` |
| 英文 | `What's on your mind` |
| 韩文 | `무슨 생각을`（你在想什么）/ `게시물 만들기`（创建帖子） |
| 意大利文 | `A cosa stai pensando` / `Crea post` |

兜底（页面不是 role=button 时）：找文本含上述关键词、宽 400-800、高 30-100 的 div。

## 3. 发布框（composer dialog）

| 元素 | 选择器 / 特征 |
| --- | --- |
| 主发布框 | `[role="dialog"]`，宽 500，**含** `div[contenteditable="true"]`，bottom>0 |
| 隐藏副本 | `[role="dialog"]`，宽 500 高 60，**无** contenteditable，文本仅「创建帖子/Crea post/게시물 만들기」 |
| 正文编辑框 | `div[contenteditable="true"]`（宽>40 取最大的一个） |
| 图片上传 input | `input[type="file"][accept*="image"]`（注入用 `DOM.setFileInputFiles`） |
| 附件预览 | `[role="dialog"] img` 且 `naturalWidth > 200` 计数 |

### 3.1 图片上传后出现「带图弹窗」（图文必须进同一层）
- 特征：`[role="dialog"]` 同时含大图（naturalWidth>200）和 contenteditable；
- 文本含「编辑 / 添加更多内容 / 这项内容无法与已添加的内容一起加入帖子」——
  最后这句是**虚报**，不影响发布；
- 文案必须写进**带图弹窗**的编辑框（不是原发布框），否则发出来图文分离；
- 多图会触发真实「内容冲突」禁用发帖，默认 1 张图。

## 4. 隐私按钮（点它打开可见范围弹窗）

元素：`div[role="button"]`，`aria-label` 以这些开头：

| 语言 | aria-label 前缀 |
| --- | --- |
| 中文 | `编辑隐私设置` |
| 英文 | `Edit privacy` |
| 韩文 | `공개 범위`（注意：按钮名固定含「공개 범위」，不代表已公开！） |
| 意大利文 | `Modifica la privacy` |

注意：按钮可能在视口外（如意大利文 x=-17），点击前先 `scrollIntoView({block:"center"})`。

## 5. 可见范围弹窗（设公开）

### 5.1 弹窗标题

| 语言 | 关键词 |
| --- | --- |
| 中文 | `谁能看到你的帖子` |
| 英文 | `Who should see` |
| 韩文 | `게시물 공개 대상` / `내 게시물을 볼 수 있는` |
| 意大利文 | `Chi può vedere` |

### 5.2 公开选项

| 语言 | 选项文本 |
| --- | --- |
| 中文 | `公开` |
| 英文 | `Public` |
| 韩文 | `전체 공개` |
| 意大利文 | `Pubblico` 或 `Tutti`（所有人） |

选项行：`div`，文本以上述开头，宽>300、高 50-200。

**点击目标（关键）**：选项行内 `input[type="radio"]` 藏在屏幕外（x > innerWidth），
必须点**可见圆点**——行内 20-40px 的方形 `div`/`span`。

### 5.3 完成/保存按钮

| 场景 | 按钮 |
| --- | --- |
| 发布前设公开 | 完成 / Done / 완료（aria-label=`공개 대상 선택 완료 및 대화 상자 닫기`）/ Fine / Fatto |
| 已发布帖子改公开 | 保存（aria-label=`保存隐私分享对象选择并关闭对话框`） |

验证：隐私按钮 aria-label 含 `分享对象：公开 / Shared with: Public / 전체 공개 / Pubblico / Tutti`
才算公开；韩文按钮的「공개 범위」是按钮名，**不能**当作已公开。

## 6. 发帖按钮（多语言）

元素：`[role="dialog"] div[role="button"]`，文本或 aria-label **精确等于**：

`发帖 | Post | 게시 | Pubblica | Publicar | Veröffentlichen | Publier | 发布`

过滤：`aria-disabled !== "true"`（有禁用副本）；多个时取 top 最大的。

## 7. Reels 引导弹窗（挡发布框的元凶）

触发：部分账号打开发布框时弹出，叠在发布框上导致「找不到可见发布框」。

| 语言 | 关键词 |
| --- | --- |
| 中文 | `检查分享对象` / `所有视频帖现在都是 Reels` / `Reels 现在` |
| 韩文 | `공개 대상 검토` / `릴스` |

处理（实测可靠）：
1. 直接移除该 dialog（不含 contenteditable 且文本含上述关键词）；
2. 循环移除**残留全屏遮罩**：`elementFromPoint(发布框中心)` 命中的、不在任何 dialog 内、
   宽≥1000 高≥300 的 DIV，最多 25 层；
3. 发布框保持可用（移除不会触发 React 重渲染）。

## 8. 发布后验证

| 方式 | 判断 |
| --- | --- |
| 发布框关闭 | `[role="dialog"]` 中带 contenteditable 的数量 = 0 |
| 页面提示 | body 文本含「你的帖子已成功分享」 |
| 个人主页 | URL `facebook.com/me`，`[role="article"]` 含文案 probe |
| 活动日志 | `facebook.com/profile.php?id=<id>&sk=allactivity`，条目含文案+「公开」+时间 |

注意：部分账号发布后弹窗残留（Facebook bug），**弹窗残留≠没发布**；
发布按钮点击一次后不再重试，否则会造成同一账号多条重复帖。

## 9. 帖子元素（互动 / 删除 / 改可见范围）

### 9.1 帖子
- 单条帖子：`[role="article"]`；
- 帖子头部菜单按钮：`aria-label` 含「可对XX的这篇帖子执行的操作」（帖子）或
  「针对XX...的更多选项」（活动日志）；
- 时间戳链接：`permalink.php?story_fbid=...&id=<profileId>`。

### 9.2 删除帖子（移到垃圾箱）
1. 活动日志：`...&sk=allactivity`；
2. 点条目的「更多选项」按钮（**避开右上角通知铃铛**：选 y>80 的按钮）；
3. 菜单点「移至垃圾箱」（韩文/英文界面同理：Move to Trash）；
4. 确认弹窗点「移至垃圾箱」——必须用 elementFromPoint 点 `div[role="button"]`，
   点隐藏副本不生效。

### 9.3 已发布帖子改公开
1. 个人主页滚动到帖子，`[role="article"]` 匹配文案；
2. 悬停触发帖子头部「编辑分享对象」（aria-label=`编辑分享对象` / `Edit audience`）；
3. 弹窗选公开选项（同第 5 节，点可见圆点）；
4. 点「保存」。

## 10. 写 Automa 工作流的建议

1. **文本定位用「元素文本」条件**，多语言界面用多条件分支（或分支判断界面语言后选不同分支）；
2. **输入正文**：用 Automa「执行脚本」块，对 `div[contenteditable="true"]` 聚焦后
   `document.execCommand('insertText', false, 文本)` 或 CDP `Input.insertText`；
3. **上传图片**：用 Automa「上传文件」块指向 `input[type="file"]`（绕过系统对话框）；
4. **点公开选项**：不要点 `input[type="radio"]`（在屏幕外），点行内可见圆点；
5. **发帖按钮**：精确匹配文本 + 过滤 `aria-disabled="true"`；
6. **Reels 引导**：工作流开头加「移除弹窗」脚本块（移除含 `Reels/릴스/检查分享对象`
   且无 contenteditable 的 dialog + 全屏遮罩）；
7. **发布后**：以「发布框关闭」为准，不要重试，避免重复帖；
8. **元素不稳定是常态**：Facebook 频繁改版，脚本/工作流要留文本兜底和多语言分支。

## 11. 配套脚本索引

| 脚本 | 作用 |
| --- | --- |
| `fb-input.mjs` | JS 合成点击/按键（Cloak 内核兼容） |
| `fb-post.mjs` | 发帖（图文+公开+防重+多语言） |
| `fb-batch-post.mjs` | 3-5 窗口并发批量发帖（完成即关） |
| `fb-login-status.mjs` | 登录状态检测 |
| `fb-set-post-public.mjs` | 已发布帖子改公开 |
| `fb-delete-activity.mjs` | 活动日志删除重复/测试帖（D:\ 临时，未入库） |
| `fb-login.mjs` / `fb-batch-login.mjs` | 自动登录 / 批量登录 |
