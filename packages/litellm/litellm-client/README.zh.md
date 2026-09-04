---
description: "面向维护者的 LiteLLM 代理管理客户端说明，用于验证虚拟密钥、读取按密钥划分的模型目录并归类代理故障。"
kind: "package-reference"
---

# @deepseek-ai/dsh-litellm-client

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-litellm-client` 与 [LiteLLM](https://docs.litellm.ai) 代理的管理 API 通话：它验证一把虚拟密钥并读出它属于谁，列出该密钥可请求的模型，并把代理的拒绝转换成 harness 的提供方中立故障码。这里的一切都**以调用方的密钥身份**行事——没有管理员凭据，也没有环境中的进程密钥，因为一个服务多位已登录用户的进程绝不能混淆他们的权限。之后由代理自身的授权决定每把密钥能看到什么，因此 harness 从不重新实现代理的访问规则。本包是一个普通库，没有 Cordis 插件、没有配置，除端点与超时外也没有状态。

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

当插件必须就一把密钥或其背后的模型询问 LiteLLM 代理时，依赖本包。为每个端点构造一个客户端，并在每次调用时传入密钥：

```ts
import { LiteLlmClient } from '@deepseek-ai/dsh-litellm-client'

declare const submittedKey: string

const client = new LiteLlmClient({ baseURL: 'https://proxy.example', timeoutMs: 15_000 })
const identity = await client.verifyKey(submittedKey)
const models = await client.listModels(submittedKey)
```

### 验证密钥并得知持有者

`verifyKey` 先问 `/key/info`，因为该端点针对提交的这把密钥本身作答。若代理未暴露它——或只对管理员密钥暴露它，从而对普通虚拟密钥返回 401——则回退到 `/user/info`，其回复指向同一位用户。两个端点都拒绝的密钥会抛出携带 `/key/info` 判定的 `LiteLlmRequestError`，这样登录界面就能区分“密钥不对”与“密钥没有可寻址的用户”；后者返回 `undefined`。

返回的 `LiteLlmKeyIdentity` 携带 `userId`，而密钥本身绝不是其中的字段：这条记录会流向配置界面与诊断信息，而抵达任一处的密钥都是泄漏。未附带用户 id 签发的密钥会回退到其团队 id，再回退到其别名，因为按该值寻址持久的按用户数据的调用方不能让它留空。`models` 列出该密钥可请求的内容，其中空表示不受限——LiteLLM 有三种写法（缺失的列表、空列表以及 `all-proxy-models` 通配符），三者到这里都成为空列表。

### 读取密钥可用的模型目录

`listModels` 先问 `/model/info` 以取得其容量与能力标志，当代理限制了该管理端点时再问 `/v1/models`。两者都为空时返回空而非抛错，因为代理完全可能合法地不给某把密钥任何模型，是否算错误由调用方决定。id 会去重，因为把同一模型挂在多个部署下的代理会重复其公开别名。

### 用任一书写形式指向代理

LiteLLM 自己的文档同时发布 `https://proxy.example` 与 `https://proxy.example/v1`——OpenAI 基础 URL 带版本段，管理端点不带。`liteLlmApiRoot` 把两者归一到同一个 API 根，`liteLlmChatCompletionsUrl` 从任一形式构造对话端点，因此复制了任一形式的部署都能触及两半。

### 归类一次拒绝

`classifyLiteLlmFailure(status, body, retryAfter)` 先读代理的消息再看状态码，因为 LiteLLM 把预算超限与 TPM/RPM 配额耗尽都报为 HTTP 400。只读状态码的调用方会对前者无休止重试，而对后者立刻放弃。结果携带提供方中立的码——`AUTH`、`QUOTA`、`RATE_LIMIT`、`BAD_REQUEST`、`UNKNOWN_MODEL`、`SERVER`、`TRANSPORT`——外加状态码，以及当响应携带 RFC 9110 两种写法之一的可用 `Retry-After` 时的毫秒延迟。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

本节解释客户端背后的设计；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 解析是收窄，而非校验

代理的 `/key/info` 载荷随其数据库模式与版本而变，同一批事实会依端点与构建版本出现在 `info` 下、`user_info` 下以及顶层平铺处。因此这里的每个读取器都在收窄一份候选文档，而不是校验一份固定文档：缺失、为 `null` 或类型不符的字段视为不存在，只有调用方无法继续的那一项事实——可寻址的用户 id——才把缺失变成拒绝。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 客户端、URL 归一与载荷读取器 |
| [`src/failure.ts`](src/failure.ts) | 消息优先于状态码的归类与 `Retry-After` 解析 |
| [`src/types.ts`](src/types.ts) | `LiteLlmKeyIdentity` 与 `LiteLlmModel` |
| [`tests/client.spec.ts`](tests/client.spec.ts) | 已覆盖行为：密钥验证、回退、目录读取、URL 归一 |
| [`tests/failure.spec.ts`](tests/failure.spec.ts) | 已覆盖行为：预算与配额标记、状态码回退、重试延迟 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当客户端约定还不够时阅读这些页面。它们从本库走向使用它的插件。

- [dsh-litellm-auth](../litellm-auth/README.zh.md) — 在登录时通过本客户端验证提交的密钥。
- [dsh-llm-litellm](../../llm/llm-litellm/README.zh.md) — 通过本客户端读取按用户的目录，并自行流式发起模型调用。
- [dsh-litellm-web](../../bundle/litellm-web/README.zh.md) — 同时挂载两者的 profile bundle。
- [LiteLLM 代理文档](https://docs.litellm.ai) — 上游服务及其管理 API。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只执行管理 API 读取，不发送任何模型请求。

#### KV 缓存影响

无；本包发出的任何请求都不会触及模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定客户端到此为止。它们是本包当前的约束，而不是对代理客户端的通用比较或任务待办。

- **没有分页** — `/model/info` 与 `/v1/models` 都按一页读取。服务的模型多于单次响应所能承载时会被静默截断。
- **预算与配额标记是英文子串** — 归类读取的是 LiteLLM 自身的措辞。改写或本地化这些错误的代理构建会回退到状态码，并失去 `QUOTA` 与 `RATE_LIMIT` 的区分。
- **`expiresAt` 只读取不强制** — 当代理声明过期时间时身份会携带它；这里不拒绝过期密钥，因为代理会在下一次请求时拒绝它，而那个判定才是权威的。
- **没有缓存** — 每次调用都是一次请求。按模型选择读取目录的调用方自行缓存。
- **`spend` 与 `maxBudget` 是快照** — 两者都在验证时读取，读到即过时；它们为界面描述账户，绝不用于闸住请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的方向与给维护者的备注。已发布行为与既定理由存放于上文各节与包代码中。

- `/key/info` 到 `/user/info` 的回退之所以存在，是因为各代理部署对普通虚拟密钥暴露哪些管理端点各不相同。若未来某个 LiteLLM 版本把这一点定下来，该回退就成了累赘，应当移除。
- 这里不向代理写入任何东西。密钥签发、预算与团队成员关系仍归代理运营方管理，把其中任何一项拉进 harness 都会让两套系统同时管一个账户。

</details>

**运行时不变量：** 未发布伴生包。本包是 HTTP 之上的无状态库，没有可观察的独立事件序列或可变数据关系。
