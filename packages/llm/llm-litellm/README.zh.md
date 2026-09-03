---
description: "面向用户与维护者的 LiteLLM 提供方路由说明，用于以每位已登录用户自己的密钥经代理路由模型请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-litellm

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-litellm` 在 harness LLM 接缝上注册 `litellm` 提供方路由，并把每次模型调用通过 [LiteLLM](https://docs.litellm.ai) 代理的 OpenAI 兼容端点流式发出。它的存在是为了一项通用网关适配器无法提供的行为：**请求以发起它的那个人的身份被认证。** 当 `ctx.principal` 指名一位已登录用户时，线上的密钥就是该用户自己的虚拟密钥，因此代理执行他们的模型访问与预算，并把花费记在他们名下；配置的 `apiKeyEnv` 引用是无人发起的工作——计划任务、CLI 运行——的兜底，绝不覆盖已登录用户的密钥。模型发现遵循同一规则，因此每个人被提供的是其自己密钥可用的目录，而不是配置里声明的那一份。

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

当模型请求要经过 LiteLLM 代理时挂载本插件。[`dsh-litellm-web`](../../bundle/litellm-web/README.zh.md) bundle 会把它与登录一起挂载；若要自行组合 profile，则直接挂载：

```yaml
- id: llm-litellm
  name: '@deepseek-ai/dsh-llm-litellm'
  config:
    baseURL: https://litellm.internal
    apiKeyEnv: LITELLM_API_KEY
    defaultContextWindow: 128000
    retryPolicy:
      mode: normal
      maxRetries: 3
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | 必填 | 代理 URL，带或不带 `/v1` 后缀 |
| `apiKeyEnv` | `LITELLM_API_KEY` | 无人发起的请求所用的凭据引用；已登录的密钥总是胜出 |
| `timeoutMs` | `600000` | 模型请求超时 |
| `catalogTimeoutMs` | `15000` | 每次目录读取的超时 |
| `catalogTtlSeconds` | `300` | 按用户的目录缓存时长 |
| `defaultContextWindow` | `128000` | 代理未标注容量的模型所假定的容量 |
| `headers` | 无 | 每次代理请求附加的请求头，用于部署路由 |
| `retryPolicy` | normal，5 次重试 | 由 `dsh-llm-retry` 执行的路由自有策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

### 知道请求使用哪把密钥

优先级是本包的约定，恰好只有两步。若请求上绑定了主体，其密钥上线。否则通过凭据接缝解析 `apiKeyEnv`。两者皆无的请求以 `MISSING_CREDENTIAL` 失败，并指明两种修法。

配置中的任何东西都无法颠倒这一顺序，这正是要点：运维者不可能不小心让一个人的工作记到另一个人的账上，共享的部署密钥也不会悄悄服务一位代理本会拒绝其自有密钥的用户。

挂载 [`dsh-litellm-auth`](../../litellm/litellm-auth/README.zh.md) 才会有已登录用户；没有主体接缝时，本路由的表现与普通的已配置网关一样。

### 知道每个人看到哪些模型

`listModels` 以发起请求者的密钥读取代理的 `/model/info`，因此目录反映该密钥的访问权。目录按主体缓存 `catalogTtlSeconds`，绝不按进程缓存，因为同一代理上的两个人本就会看到不同的目录，而共享缓存会把先问的那个人的结果展示给之后的所有人。不肯列出模型的代理会退化为空目录并记录一条诊断，而不是让模型选择失败；调用方指名的模型仍会被请求：代理才是它是否服务该模型的权威，并在请求到达时给出答复。

### 理解失败

代理拒绝以携带提供方中立码的 `LlmError` 到达。`AUTH` 是被拒的密钥，`QUOTA` 是超出的预算，`RATE_LIMIT` 是耗尽的配额，`UNKNOWN_MODEL` 是代理不服务的模型，`TRANSPORT` 是无法触及的代理。LiteLLM 把预算超限与 TPM/RPM 配额耗尽都报为 HTTP 400，因此归类先读代理的消息再看状态码；只读状态码的调用方会对前者无休止重试，而对后者立刻放弃。

未见终止符就结束的流以 `STREAM_CLOSED` 失败，而不是把短答复报成完整答复；流内错误对象——LiteLLM 报告响应头发出之后才出现的上游故障的方式——成为对应的终止性失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

本节解释适配器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 请求所需的一切都在其首次 await 之前捕获

`stream` 在触网之前读取连接事实并解析凭据，因此请求中途的设置变更无法把一代的端点与另一代的密钥组合起来。适配器自身根本不持有密钥：`resolveApiKey` 是交给它的函数，每次请求调用一次，这正是让按用户认证成为传输属性而非挂载属性的原因。

### 块是被指派的，不是被携带的

harness 的块带索引且显式开合，而 OpenAI 流交错发送无标签的文本、推理与工具调用增量。`BlockWriter` 独占这份映射，别处都不做。被另一通道打断后再出现的通道会开一个**新**块，而不是重开已关闭的那个，因为 harness 协议没有重开，而记录必须保持模型产出的顺序。

### 两处投影没有直接对应物

harness 的工具结果位于用户角色消息内部，在线上成为独立的 `tool` 消息。推理在请求中被整体丢弃：LiteLLM 前置的任何提供方都不接受把自己的思考作为输入回传，发送它会把上下文花在模型随后又重新推导的 token 上。

### 用量是显式索取的

只有在调用方设置 `stream_options.include_usage` 时，LiteLLM 才在最后一个分块上转发用量。没有它，harness 会把每次调用都记为零成本，因此适配器总是设置它。harness 的计数是互不相交的，而 OpenAI 的 `prompt_tokens` 是已包含缓存输入的合计值，因此缓存部分会被减去。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、凭据规则、按主体的目录缓存、注册 |
| [`src/adapter.ts`](src/adapter.ts) | 请求、SSE 读取与模型元数据 |
| [`src/serialize.ts`](src/serialize.ts) | harness 消息与工具向 chat-completions 请求体的投影 |
| [`src/stream.ts`](src/stream.ts) | 块指派、结束原因与 token 计量 |
| [`tests/plugin.spec.ts`](tests/plugin.spec.ts) | 已覆盖行为：请求以哪把密钥行事、每个人被提供哪些模型 |
| [`tests/adapter.spec.ts`](tests/adapter.spec.ts) | 已覆盖行为：线上请求、流式响应、拒绝 |
| [`tests/serialize.spec.ts`](tests/serialize.spec.ts) | 已覆盖行为：消息与工具投影 |
| [`tests/stream.spec.ts`](tests/stream.spec.ts) | 已覆盖行为：块指派、结束映射、用量 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定还不够时阅读这些页面。它们从路由走向它注册于其上的接缝以及它读取的身份。

- [dsh-llm 服务](../llm/README.zh.md) — 本适配器注册于其上的提供方中立服务。
- [dsh-principal](../../identity/principal/README.zh.md) — 指名发起请求者的接缝。
- [dsh-litellm-auth](../../litellm/litellm-auth/README.zh.md) — 让人们登录并绑定他们的提供方。
- [dsh-litellm-client](../../litellm/litellm-client/README.zh.md) — 目录读取背后的管理客户端。
- [dsh-llm-retry](../llm-retry/README.zh.md) — 应用本路由策略的重试执行器。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md) — `StreamChunk` 协议与适配器约定。
- [dsh-litellm-web](../../bundle/litellm-web/README.zh.md) — 挂载本路由的 profile bundle。

-----

<a id="model-experience"></a>
## 模型体验

### 经代理的提供方请求

#### 模型看到什么

被选中的模型收到作为独立 `system` 消息的系统提示词、按请求顺序排列的对话，以及请求提供的工具 schema。工具结果作为按调用 id 关联的 `tool` 消息到达，失败的结果以 `Error:` 为前缀，因为线上没有别的字段承载它。历史中的推理内容不被发送。运行时未投影为文本的图像块会以其附件 id 指名而非被丢弃，这样模型能知道曾经存在某物。

#### Token 影响

提供方的分词决定精确输入，而 LiteLLM 把请求转发给别名所指的上游模型。丢弃推理会从此后的每次请求中移除那些 token。被指名的图像只贡献其描述文本。

#### KV 缓存影响

转换保持逻辑请求顺序，因此稳定的前缀保持稳定。更换模型别名、其背后的代理路由或任何更早的消息，都会产生通常的后缀效应。由于推理从不重发，产生过推理的一轮不会加长下一次请求的前缀。

### 提供方响应

#### 模型看到什么

流增量成为 harness 的推理、文本、工具调用、用量与结束分块。工具调用参数按模型产出的原始 JSON 字符串原样透传。`content_filter` 结束被记为正常停止，因为上游提供方完成了该次调用，而它产出的响应就是这一轮的内容。

#### Token 影响

生成的内容只有在循环记录之后才影响后续输入。代理报告的缓存输入会从输入计数中减去并单独报告，因此计费输入是各互不相交计数之和。

#### KV 缓存影响

记录下来的响应内容追加到下一次请求，不会使其更早的可复用前缀失效。用量计量与传输元数据不影响缓存身份。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定路由到此为止。它们是本包当前的约束，而不是对 LiteLLM 的通用比较或任务待办。

- **线上不支持图像输入** — 图像块以其附件 id 的文本形式抵达模型。代理的 `image_url` 内容分片未被构造，因此代理背后的视觉模型看到的是描述而非图片。
- **没有重放状态** — 适配器不存储提供方原生的响应元数据，因此本可从自身状态续接的提供方只能重读对话。
- **没有请求图像计价** — token 计量器对本路由回退到自己的中立估计。
- **每人每个 TTL 的目录读取各耗一次请求** — 已登录者众多且 `catalogTtlSeconds` 很短的部署会给 `/model/info` 带来持续负载。
- **缓存的目录不会被代理主动失效** — 被授予新模型的密钥要等过 `catalogTtlSeconds` 界面才会提供它。
- **`defaultContextWindow` 是一个猜测** — 代理未标注容量的模型被假定为这么大，猜错是以提供方拒绝的形式被发现，而不是本地检查。
- **预算与配额归类读取英文代理消息** — 改写这些错误的代理构建会回退到 HTTP 状态码并失去 `QUOTA` 与 `RATE_LIMIT` 的区分，从而改变重试执行器是否再试。
- **每次挂载一个路由** — 路由名是固定的，因此挂载本插件两次并不能同时触及两个代理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的方向与给维护者的备注。已发布行为与既定理由存放于上文各节与包代码中。

- 图像支持是最大的缺口，且大体上是机械工作：投影已经知道哪些块是图像，缺的那一半是解析附件字节并在按模型的能力检查下发出 `image_url` 分片。
- 目录缓存按主体 id 建键并在卸载时清空。它有意不按密钥哈希建键：同一个人的两个会话共享目录，这符合此人的预期，而会话中途轮换的密钥会在下一个 TTL 边界被采用。

</details>

**运行时不变量：** 未发布伴生包。除在其所属接缝处强制的约定外，本包不暴露独立的事件序列或可变数据关系。
