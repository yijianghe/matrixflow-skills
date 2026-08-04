# MatrixFlow 本地 API 参考

## 基本信息

- 基地址：`http://127.0.0.1:19527`（环境变量 `MF_LOCAL_API` 可覆盖）
- 认证请求头：`X-MatrixFlow-Token: <token>`（或 `Authorization: Bearer <token>`）
- Token 文件：`<userData>/local-api-token.txt`；环境变量 `MF_LOCAL_API_TOKEN` 可覆盖
- userData 路径：
  - Windows：`%APPDATA%\@matrixflow\desktop`
  - macOS：`~/Library/Application Support/@matrixflow/desktop`
  - Linux：`~/.config/@matrixflow/desktop`
  - 环境变量 `MF_USER_DATA` 可覆盖
- 返回格式：成功 `{ "success": true, "data": ... }`；失败 `{ "success": false, "error": { "message": "..." } }`

## 常用接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/profiles/running` | 列出运行中的环境（窗口） |
| GET | `/api/v1/profiles` | 列出全部环境（离线时退化为仅运行中的） |
| POST | `/api/v1/profiles/:id/open` | 打开环境窗口。可选 body：`postLaunchUrls: string[]`、`startupUrl`、`colorMode`、`loadAutomaExtension`、`automaWorkflowId`、`headless`、`windowSize` |
| POST | `/api/v1/profiles/:id/close` | 关闭环境窗口 |
| GET | `/api/v1/matrixflow/local-api/info` | 返回 `baseUrl`、`token`、`header`、`swaggerUrl`、`docsUrl` |
| GET | `/api/v1/matrixflow/workflows` | 工作流列表 |
| GET | `/api/v1/matrixflow/rpa/target-tabs` | RPA 目标标签页 |

## CDP（逐窗口页面控制）

每个运行中环境的 Chromium 都会在以下位置暴露调试端口：

```
<userData>/Profiles/<userId>/<profileId>/DevToolsActivePort
```

第一行就是调试端口号，然后：

- 浏览器级端点：`http://127.0.0.1:<port>/json/version` → `webSocketDebuggerUrl`
- 页面级端点（更快，推荐）：`http://127.0.0.1:<port>/json/list` → 每个 page 目标都有 `webSocketDebuggerUrl`，直接连它，无需 attach
- 常用 CDP 方法：`Page.navigate`、`Runtime.evaluate`、`Input.dispatchMouseEvent`、`Input.insertText`、`Page.captureScreenshot`、`Page.bringToFront`（激活标签页）

技能的 `scripts/mf-browser.mjs` 已封装以上全部逻辑，优先使用脚本而不是手写 CDP。

## 故障排查

- **API 不可达 / 401**：MatrixFlow 应用没在运行，或 Token 文件缺失。启动应用，然后在应用"设置 → API 文档"里查看/复制 Token。
- **DevToolsActivePort 不存在**：环境窗口没在运行。先 `open` 打开它，等几秒让浏览器起来。
- **一个窗口多个标签页**：CDP 命令默认操作“第一个非内部页面标签”；用 `pages` 查看后，用 `profileId@网址片段` 锁定目标标签。
