# 小红书发布：原生「文字生成图片」封面 + 仅自己可见（验证通过 2026-08-05）

目标：不用本地素材/占位图，直接用小红书创作平台自带的「写文字生成图片」做封面，
正文用共鸣式文案，发布前改成「仅自己可见」（私密）。

适用页面：`https://creator.xiaohongshu.com/publish/publish?source=official`
（需要先在浏览器环境里登录小红书创作服务平台，账号：韩bao）。

## 零、快速发布脚本（2026-08-05 新增，推荐直接用）

`scripts/xhs-publish.mjs` 一条 CDP 连接跑完：切「上传图文」→ 文字转图片 → 随机选模板 →
填标题/正文 → 改「仅自己可见」→ 发布。实测发布流程 ~10-15 秒（同文案走缓存秒出）。

```bash
node scripts/xhs-publish.mjs <profileId> \
  --title "标题（≤20字）" --cover "封面文字" --body-file D:\body.txt \
  --template random --visibility 仅自己可见
```

- 模板：默认 random（每次随机不同），也可指定 `基础/美漫/插图/涂鸦/涂写/清新/边框/备忘/简约/光影/手写`；
- 本地图片：`--image <路径>` 或 `--image-dir <文件夹>`；默认自动从
  `C:\Users\admin\Downloads`、桌面、`C:\Users\admin\Documents\ShareX\Screenshots` 找图；
  客户问"图片在哪"就回答这三个位置（下载目录 / 桌面 / ShareX 截图目录）；
- `--draft` 只填表单尝试存草稿（草稿按钮可能藏在"更多"菜单，找不到会保留表单）；
- 公开发布必须显式 `--visibility 公开可见`（默认强制私密）。

### 模板随机选择实现要点

生成完成后，模板网格是 `.cover-item-container`（名字在 `.cover-name`），网格可滚动
（10 套：基础/美漫/插图/涂鸦/涂写/清新/边框/备忘/简约/光影/手写，部分名字与旧文档不一致）。
选法：先把模板列表滚动容器滚到底，收集视口内可见的 `.cover-item-container`，随机点一个，
用主预览图（宽 > 200px 的 img）src 前后对比验证确实切换。模板名以页面实际文本为准，
`--template` 匹配不到就自动退回随机。

## 一、核心要点（与旧流程的差异）

1. 不要用 `input[type=file]` 上传本地图；而是点击「上传图片，或写文字生成图片」入口。
2. 进入「文字配图」面板后：在 `.card-editor-container .ProseMirror` 输入封面文案，
   「生成图片」按钮从 `disabled` 变为可用，点击生成。
3. 平台会一次生成多套排版（基础/美漫/插图/涂鸦/清新/边框/备忘/简约/光影/手写），
   默认选「基础」，点「下一步」即可把封面带入发布表单（图片数量显示为 1/18 之类）。
4. 发布按钮在自定义元素 `xhs-publish-btn` 的**内部 shadow DOM** 里，普通 `querySelector`
   找不到。通过 `document.querySelector('xhs-publish-btn')._sr.querySelector('button.bg-red')`
   可拿到红色「发布」按钮（组件暴露了 `_sr` 私有字段）。
5. 可见范围默认「公开可见」；下拉（`d-select`）要展开后选「仅自己可见」。

## 二、完整自动化步骤（CDP / Runtime.evaluate 实现）

### 1. 打开文字生成图片入口

```js
const kw = '文字生成图片';
const el = [...document.querySelectorAll('*')]
  .find(e => e.children.length === 0 && (e.textContent || '').includes(kw));
el.click(); // 触发「上传图片，或写文字生成图片」
// 等待 1-2 秒，出现「上传图片 / 文字配图」两个按钮
```

### 2. 进入文字配图面板并生成封面

```js
// 点「文字配图」按钮
const btn = [...document.querySelectorAll('button')]
  .find(b => (b.textContent || '').trim() === '文字配图');
btn.click();

// 等待面板打开后，在编辑器输入封面文案
const editor = document.querySelector('.card-editor-container .ProseMirror');
editor.focus();
editor.innerHTML = '';
document.execCommand('insertText', false, '封面文案：上班第5年，肩颈比我先退休了');

// 「生成图片」按钮此时解除 disabled
const gen = document.querySelector('.edit-text-button');
gen.click();

// 轮询等待生成完成（约 30-60 秒，平台 GPU 生成）
// 完成标志：正文区出现若干 img，或 .edit-text-button 元素消失/变化
```

### 3. 下一步带入发布表单

```js
const next = [...document.querySelectorAll('button')]
  .find(b => (b.textContent || '').trim() === '下一步');
next.click();
```

### 4. 填标题 + 正文（共鸣式，不要像广告）

标题输入框：`input[placeholder*="标题"]`（占位「填写标题会有更多赞哦」）。

正文编辑器：`.tiptap.ProseMirror`，用 `document.execCommand('insertText', ...)`，
换行会自动变成 `<p>` 段落。话题直接写在正文末尾：`#下班后充电 #下班找点新兴趣 ...`。

```js
const setTitle = (v) => {
  const el = document.querySelector('input[placeholder*="标题"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

const setBody = (v) => {
  const editor = document.querySelector('.tiptap.ProseMirror');
  editor.focus();
  editor.innerHTML = '';
  document.execCommand('insertText', false, v);
};
```

参考文案（已验证可用的共鸣模板，成都双流 SPA 引流）：

```
标题：双流打工人，周五晚上终于找到充电的方式
正文：
通勤一小时，对着电脑八小时，肩颈硬得不像自己的
被同事抓去一家她私藏的SPA
90分钟精油，按到肩颈那一下我直接睡着了
不推销不办卡，按完就走
坐标双流，具体位置私我发你～
#下班后充电 #下班找点新兴趣 #工作日晚上 #下班后的别样生活
```

### 5. 改成「仅自己可见」

先滚动 `.publish-page` 到「更多设置」区域，然后：

```js
// 用真实鼠标事件打开下拉（synthetic click 对 d-select 无效）
// 1) 先把 .permission-card-select 滚动到视口中央，得到中心坐标 (x, y)
// 2) 用 CDP Input.dispatchMouseEvent 在该坐标 mousePressed + mouseReleased
// 3) 下拉出现「公开可见/仅自己可见/仅互关好友可见/只给谁看/不给谁看」
// 4) 找到文本为「仅自己可见」的叶子元素，再算坐标，用 CDP 真实鼠标点击
```

验证：`.permission-card-select` 的 textContent 变为「仅自己可见」。

### 6. 发布（按钮在 shadow DOM 里）

```js
const host = document.querySelector('xhs-publish-btn');
const sr = host._sr; // 组件内部暴露的 shadowRoot
const submit = sr.querySelector('button.bg-red'); // 红色「发布」按钮
submit.click();
```

发布成功后页面跳转 `https://creator.xiaohongshu.com/new/home?source=official`，
草稿箱提示消失，最新笔记列表出现该条（数据小时级更新）。

## 三、速度优化建议

1. 全程只连一次 CDP WebSocket（不要每条命令重启进程/重新连接）。
2. 等待用轮询（readyState / 元素出现），不用固定 sleep。
3. 文案提前在本地写好，直接一次性插入，不逐字模拟打字。
4. 封面生成是平台 GPU 服务，等待时并行准备标题/正文/话题。
5. 实测（2026-08-05 第二次发布）：页面若停在上传视频模式，先切「上传图文」；
   「生成图片」按钮用 `element.click()` 有时不触发，改用 CDP 真实鼠标点击
   （先 scrollIntoView 取中心坐标，再 Input.dispatchMouseEvent）几乎秒触发。
6. 实测（2026-08-05 第三次发布，商K行业）补充两个坑：
   - 打开发布页后可能停在「上传视频」模式（正文区出现"拖拽视频到此"），
     必须先点顶部「上传图文」标签切换；注意 DOM 里存在**多个同名"上传图文"叶子**
     （含隐藏副本，坐标是负数），必须过滤 `getBoundingClientRect()` 在视口内
     （x/y ≥ 0 且 < innerWidth/innerHeight）的可见元素再点；
   - 「生成图片」完成后页面布局会变（`.card-editor-container` 消失、出现
     `zeusengine-gpu-server` 图片），轮询不要只盯旧选择器，改判断
     "任意宽 > 200px 的 img 存在 + 生成按钮消失"即视为成功，再点「下一步」。

## 四、常见坑

- 「生成图片」按钮在文字为空时是 `disabled`，必须先输入文字。
- 发布按钮不在普通 DOM，用 `xhs-publish-btn._sr` 才能拿到。
- 「公开可见」下拉用 `element.click()` 打不开，必须用 CDP 真实鼠标坐标点击。
- 正文里 `\n` 通过 execCommand insertText 会变成段落，不要在 innerHTML 里手工拼 `<p>`。
- 设置「仅自己可见」后发布，外部不可见，但后台仍会做审核。
- **标题最多 20 个字**：超过会显示 `24/20` 之类，发布可能被拦（点发布无反应/不跳转）。
  发布前必须把标题控制在 20 字以内（含标点、字母按字符计）。示例超长标题
  `双流！！花小钱可以呆一下午的SPA被我找到了！！！`（24 字）改成
  `双流！！花小钱可以呆一下午的SPA`（17 字）后正常发布。
- 发布成功标志：发布页 URL 变为 `...?source=official&published=true`，页面回到上传模式；
  随后「笔记管理 → 仅自己可见」列表出现该笔记。不要只看首页「最新笔记」，它有延迟。
