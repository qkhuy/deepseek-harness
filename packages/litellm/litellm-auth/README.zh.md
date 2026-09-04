---
description: "面向用户与运维者的 LiteLLM 虚拟密钥登录说明，适用于让多人共用同一套 Web 界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-litellm-auth

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-litellm-auth` 让人们用 [LiteLLM](https://docs.litellm.ai) 虚拟密钥登录，从而把 Web 界面变成多用户的。一把凭据同时干两件事：该密钥经代理自身的管理 API 验证，这就是此人向本 harness 完成认证的方式——不存在第二套账户系统——同一把密钥随后被保存在其会话中，使他们发起的每一次模型请求都由代理授权、计入预算并记账到他们名下。挂载本插件即提供 `ctx.principal`，由此引出三件事：`/api` 开始拒绝未认证的请求，工作区注册表把每个人的工作区与他人分隔，模型请求携带发起者自己的密钥而非环境中配置的任何密钥。密钥绝不写入磁盘。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当不止一人使用同一套 harness 部署，且已有 LiteLLM 代理决定他们是谁、可以花多少时，挂载本插件。[`dsh-litellm-web`](../../bundle/litellm-web/README.zh.md) bundle 会替你挂载它；若要自行组合 profile，则直接挂载：

```yaml
- id: litellm-auth
  name: '@deepseek-ai/dsh-litellm-auth'
  inject: [webServer]
  config:
    baseURL: https://litellm.internal
    requireLogin: true
    secureCookie: true       # set wherever the surface is served over HTTPS
    sessionTtlMinutes: 720
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | 必填 | 代理 URL，带或不带 `/v1` 后缀。没有默认值：猜一个会把用户的密钥送去他们未指名的地方 |
| `sessionTtlMinutes` | `720` | 自登录起的会话时长 |
| `verifyTimeoutMs` | `15000` | 每次密钥验证调用的超时 |
| `cookieName` | `dsh-litellm-session` | 会话 cookie 名称 |
| `secureCookie` | `false` | 是否为 cookie 标记 `Secure` |
| `requireLogin` | `true` | 是否拒绝未认证的请求 |
| `headers` | 无 | 每次代理管理调用附加的请求头，用于部署路由 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

### 登录

插件在 `/auth/litellm` 提供自己的登录页，由宿主渲染而非内置于应用包中：浏览器要在任何 `/api` 请求获得授权之前就抵达它，而需要应用才能显示的登录表单，会要求应用在未认证状态下加载。有人输入自己的虚拟密钥，插件向代理验证它，验证成功则开启会话并把他们送回原本要去的地方。

拒绝会说明属于哪一类，因为两类的修法不同：代理拒绝的密钥要由本人更正，而无法触及的代理则由运维者处理。代理接受但没有为其指名用户的密钥同样被拒——harness 按此人的代理用户 id 为其工作区寻址，无法把这类密钥汇入一个共享的兜底身份。

### 以程序方式登录

发送 `Content-Type: application/json` 的客户端得到的是 JSON 而非重定向。`POST /auth/litellm` 携带 `{"apiKey": "sk-…"}` 会返回会话视图——主体 id、显示名与允许的模型，绝不包含密钥——并设置同一个 cookie。`GET /auth/litellm/session` 为当前会话返回该视图或 401，`POST /auth/litellm/logout` 关闭它。

### 理解会话是什么

会话是一枚保存在本进程内存中的不透明 256 位随机令牌，通过表查找。不存在可伪造的签名载荷，其后果是有意为之的：**重启 harness 会让所有人退出登录。** 另一种做法——持久化的签名 cookie——将不得不持久保存每个人的 LiteLLM 密钥才能在重启后继续服务其请求，而本包绝不把密钥写入磁盘。从第二个浏览器登录会新增一个会话而非替换第一个，因此一个人可以在两处工作。

### 选择姿态

`requireLogin: true` 拒绝每一个未认证的 `/api` 请求，这是共享部署的姿态。`requireLogin: false` 保持界面开放，只为携带会话的请求绑定用户，这是在人们迁移期间为单操作者部署引入登录而不锁死它的方式。

在以 HTTPS 提供服务的任何地方设置 `secureCookie`。在纯 HTTP 部署上保留它会让每次登录都静默失效，因为浏览器拒绝在那里存储 `Secure` cookie。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

本节解释插件背后的设计；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 主体 id 是派生的，而非代理自己的

LiteLLM 用户 id 是其运营方签发的任意形式——UUID、电子邮件地址、SSO subject——而主体 id 要为目录与存储键寻址，因此两套词汇不能是同一个字符串。`principalIdForLiteLlmUser` 把代理 id 的可读 slug 与该 id 全文的 64 位摘要拼接起来。仅有 slug 会碰撞（`alice@a.com` 与 `alice@b.com` 归约为相同字符），仅有摘要会让每个按用户的目录都不可读，因此两者都保留，并由摘要承担唯一性。该派生是纯函数，因为该 id 为持久数据寻址：同一位代理用户必须在每次登录、每个进程、账户的整个生命周期内解析为同一个主体。

### 路由位于信任围栏之下，而非其后

登录路由直接注册在 `webServer` 上而不是 `/api` 通道上，因为 `/api` 恰恰是一个人在登录之前无法触及的东西。它们是精确路径，因此绝不会遮蔽应用自身的路由。

### 返回路径在使用前被归约

只有以根开头的同源路径能通过 `safeReturnPath`；任何以 `//` 开头、携带协议或包含反斜杠的都会变成 `/`。此处的开放重定向会把登录页变成一个可信的钓鱼链接投放点。该归约是静默的，因为跟随了被篡改链接的人应当落在应用上，而不是读到关于它的说明。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、主体提供方与三个路由 |
| [`src/session.ts`](src/session.ts) | 会话表与 cookie 编码 |
| [`src/principal-id.ts`](src/principal-id.ts) | 从代理用户 id 稳定派生主体 id |
| [`src/http.ts`](src/http.ts) | 请求体读取、返回路径归约与响应形式 |
| [`src/login-page.ts`](src/login-page.ts) | 宿主渲染的登录页 |
| [`tests/routes.spec.ts`](tests/routes.spec.ts) | 已覆盖行为：对脚本化代理的真实 HTTP |
| [`tests/session.spec.ts`](tests/session.spec.ts) | 已覆盖行为：cookie、过期、清扫、id 派生 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定还不够时阅读这些页面。它们从提供方走向它实现的接缝以及读取它的消费方。

- [dsh-principal](../../identity/principal/README.zh.md) — 本插件提供的接缝。
- [dsh-litellm-client](../litellm-client/README.zh.md) — 验证每把密钥的管理客户端。
- [dsh-llm-litellm](../../llm/llm-litellm/README.zh.md) — 在每次模型请求上发送已登录者的密钥。
- [dsh-workspace](../../workspace/workspace/README.zh.md) — 按主体分隔每个人的工作区。
- [dsh-litellm-web](../../bundle/litellm-web/README.zh.md) — 挂载本插件的 profile bundle。
- [dsh-client-connection](../../client/connection/README.zh.md) — 其认证被本插件替换的载体。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本插件不注册工具、提示词分节或会话事件，只决定之后的模型请求携带哪把凭据。

#### KV 缓存影响

无直接影响：登录到同一套部署的两个人通过相同的请求触及相同的模型，仅线上的凭据不同，而那是传输元数据。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定登录到此为止。它们是本包当前的约束，而不是对认证方案的通用比较或任务待办。

- **重启会让所有人退出登录** — 会话位于进程内存中，这正是密钥不落盘的原因。每次发布之后，每位已登录者都要重新输入密钥。
- **会话无法跨第二个进程存活** — 同一地址背后的两个 harness 进程不共享该表，因此一个人只在他触达的那个进程上处于登录状态。Web 界面今天是单进程，一旦不是，这一点就会成为现实问题。
- **会话时长是绝对的，而非滑动的** — `sessionTtlMinutes` 自登录起计时，不因活动而延长，因此跨过边界仍在工作的人会在任务中途被登出。
- **登录没有限流** — 插件会拒绝错误的密钥并说明原因；它不会减慢重复尝试。可从受信网络之外触达的部署需要在其前面加一层。
- **登录时有效的密钥在整个会话内被信任** — 代理只被问一次。此后被吊销、过期或重设预算的密钥在其会话结束前仍能在此认证，届时拒绝来自此人下一次模型请求时的代理，而不是来自登录界面。
- **每套部署一个代理** — `baseURL` 是一个端点。前置多个代理的部署无法把它们呈现为同一次登录。
- **没有客户端 UI** — 登录页由宿主渲染，不受应用自身的 locale 或主题插件影响。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的方向与给维护者的备注。已发布行为与既定理由存放于上文各节与包代码中。

- 持久会话不断被提起，而它的每个版本都需要把此人的密钥存在某处。用 harness home 的密钥加密它，只是把问题转移给能读取该 home 的人。与代理之间的刷新令牌交换才是正解，而 LiteLLM 今天并不提供。
- 登录页由宿主渲染是一项有意的取舍：它无需应用包即可加载，因此也就忽略主题与 locale 插件。若将来构建客户端登录视图，本页必须作为应用包无法加载时的兜底而保留。

</details>

**运行时不变量：** 未发布伴生包。会话表是进程私有的，没有独立观察点，它发布的身份在 `dsh-principal` 接缝处强制。
