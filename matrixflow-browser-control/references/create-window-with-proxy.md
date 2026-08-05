# 创建带代理的窗口（已验证 2026-08-05）

需求：新建一个窗口（环境）并绑定住宅/机房代理，之后该窗口所有流量都走代理 IP。

## 代理格式

应用里粘贴的格式：`host:port:username:password`（SOCKS5，无账号可只写 `host:port`）。
示例：`dc.decodo.com:10115:user-sp0xqj455d-ip-82.23.21.220:hw9ofxty_Hk4LQq59R`

## 推荐方式（技能 CLI，一条命令完成）

```bash
node scripts/mf-browser.mjs create "tk专用" --proxy "dc.decodo.com:10115:user-sp0xqj455d-ip-82.23.21.220:hw9ofxty_Hk4LQq59R"
```

脚本会自动：
1. 读取 Windows 凭据管理器里的云端登录令牌（keytar，服务名 `MatrixFlow`）；
2. 调云端 API `POST /api/v1/proxies` 创建代理（默认 SOCKS5）；
3. 调本地 API `POST /api/v1/profiles` 创建窗口并绑定 `proxyId`；
4. 输出窗口 id 和 proxyId。

> 注意：本地 API 创建接口不接受内嵌 proxy 对象（会报 `property proxy should not exist`），
> 必须先创建代理拿到 `proxyId`，再在创建窗口的 body 里传 `proxyId`。

## 手工方式（分步）

### 1. 读取云端令牌（Windows 凭据管理器）

```js
const keytar = require('<MatrixFlow安装目录>/node_modules/keytar');
const token = await keytar.getPassword('MatrixFlow', 'matrixflow-auth:accessToken');
```

### 2. 创建代理（云端 API）

```bash
curl -X POST "https://browser.lingjingxia.com/api/v1/proxies" \
  -H "Authorization: Bearer <云端令牌>" -H "Content-Type: application/json" \
  -d '{"type":"SOCKS5","host":"dc.decodo.com","port":10115,"username":"user-...","password":"..."}'
```

返回 `data.id` 即 `proxyId`。

### 3. 创建窗口并绑定代理（本地 API）

```bash
curl -X POST "http://127.0.0.1:19527/api/v1/profiles" \
  -H "X-MatrixFlow-Token: <本地Token>" -H "Content-Type: application/json" \
  -d '{"name":"tk专用","platform":"CUSTOM","proxyId":"<proxyId>"}'
```

### 4. 验证代理

```bash
node scripts/mf-browser.mjs open <profileId> "https://api.ip.sb/geoip"
node scripts/mf-browser.mjs text <profileId>
```

看到 `ip` 字段等于代理的出口 IP（如 82.23.21.220）即成功。

## 坑

- PowerShell 里 `ConvertTo-Json` 会把中文转成 `\uXXXX`，云端收到的是字面量 `\uXXXX`，窗口名会变成乱码。
  用 Node/Python 发请求，或创建后用云端 `PATCH /api/v1/profiles/:id` 修正 name（body `{ "name": "tk专用" }`）。
- 删除窗口不会自动删代理；`DELETE /api/v1/profiles/:id` 删窗口，`DELETE /api/v1/proxies/:id` 删代理。
- 创建代理用的令牌是**云端** Bearer 令牌（凭据管理器），与本地 API 的 `X-MatrixFlow-Token` 不是同一个。
