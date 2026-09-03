---
description: "面向维护者的已认证主体接缝说明，用于把请求归属于哪位用户串联到必须以该用户身份行事的插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-principal

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-principal` 是回答同一个问题的服务定义：这份工作属于谁？提供方在 HTTP 载体处回答它，请求正是带着身份到达那里的；而消费方要在离载体很远的地方发问——在选择发送哪把密钥的模型适配器里，或在决定哪些记录可见的注册表里。本接缝用 `AsyncLocalStorage` 绑定跨越这段距离，让插件读取当前用户，而不必把参数穿过那些本就不该指名用户的接缝。缺席是本仓库默认的本地姿态，并且是有意义的：未挂载提供方时服务根本不存在，`ctx.get('principal')` 返回 `undefined`，每个消费方都保持其单操作者行为不变。

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

当插件的行为因终端用户而异，或当你正在编写认证他们的提供方时，依赖本包。它发布类型与一个抽象服务；它不挂载任何东西，也没有配置。

### 读取当前用户

消费方把本接缝视为可选，因为单操作者组合并不挂载它：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-principal'

declare const ctx: Context

const principal = ctx.get('principal')?.current()
if (principal !== undefined) {
  // act as this user
}
```

`current()` 返回绑定到调用方异步区域的主体，在所有区域之外返回 `undefined`。`require(consumer)` 是同一次读取，供那些没有用户就行为未定义的插件使用：它抛出 `PrincipalRequiredError` 并指名需要用户的消费方，而不是在更晚、更远的地方失败。

`Principal` 携带四个字段。`id` 是该用户持久数据的稳定地址——按用户划分的目录、记录的所有者列——因此它在账户的整个生命周期内都不改变，也绝不是凭据本身。`displayName` 仅供 UI 界面使用。`secret` 是用户用以认证的凭据，保留下来是为了让下游调用以其身份进行；它只存在于内存中，任何消费方都不得记录它、把它写入会话事件，或放进持久记录。`models` 列出用户可请求的模型 id，其中空数组表示提供方不施加限制，而不是表示什么都不允许。

### 编写提供方

提供方继承 `PrincipalService` 并实现两个成员。`authenticate(request)` 解析一次入站请求背后的用户，且按约定是同步的：载体在任何处理器运行之前就要答复请求，因此提供方要把它所需的一切——签名密钥、活动会话表——提前加载好，而不是逐请求去取。`required` 声明是否必须拒绝未认证的请求，这让一套部署可以在不锁死自己的前提下引入登录，而另一套可以拒绝一切匿名访问。

绑定这一半是具体实现在接缝上的，而不是留给提供方，提供方不覆写它。

### 把用户绑定到区域

载体绑定一次，覆盖请求启动的一切：

```ts
import type { Principal, PrincipalService } from '@deepseek-ai/dsh-principal'

declare const principals: PrincipalService
declare const principal: Principal
declare function handleRequest(): Promise<void>

principals.run(principal, async () => {
  await handleRequest()
})
```

`handleRequest` 等待的一切都读到同一个主体，包括比响应活得更久的会话轮次，因为绑定跟随的是异步续体链，而不是 HTTP 交换。嵌套是合法的，最内层的绑定胜出。

### 按主体寻址持久数据

`principalId(value)` 在按一套狭窄语法检查后为字符串打上品牌：至多 128 个字符的小写标识符，不含点也不含分隔符。语法之所以狭窄，是因为该值被用作路径段与存储键，这样任何 id 都无法越出按用户划分的根目录，也不会在大小写不敏感的文件系统上碰撞。`isPrincipalIdName(value)` 在不抛错的前提下问同一个问题，供从上游账户 id 或令牌声明派生 id 的提供方使用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

本节解释接缝背后的设计；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 为什么绑定不归提供方所有

两个各自持有 `AsyncLocalStorage` 的提供方会彼此对对方的消费方不可见：消费方通过它解析到的服务读取，而在一个存储中所做的绑定无法透过另一个看到。因此该存储是接缝的身份，而不是实现选择，它存在于抽象类上。提供方只实现认证，那才是真正会变化的部分。

### 为什么认证是同步的

载体在分发请求之前就决定是否接受它，而那条代码路径没有合适的等待位置。把该方法定为同步，把开销推到它该在的地方：需要密钥或会话表的提供方在激活期间加载它们，并从内存作答。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 抽象服务、id 品牌与 `PrincipalRequiredError` |
| [`src/types.ts`](src/types.ts) | `Principal`、`PrincipalId` 与与载体无关的 `PrincipalRequest` |
| [`tests/principal.spec.ts`](tests/principal.spec.ts) | 已覆盖行为：id 语法、绑定隔离、嵌套、认证 |
| [`tests/memory.ts`](tests/memory.ts) | 供接缝与消费方测试使用的请求头令牌提供方替身 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当接缝约定还不够时阅读这些页面。它们从接缝走向其随仓库发布的提供方以及读取它的消费方。

- [dsh-litellm-auth](../../litellm/litellm-auth/README.zh.md) — 随仓库发布的提供方，以 LiteLLM 虚拟密钥为后端。
- [dsh-llm-litellm](../../llm/llm-litellm/README.zh.md) — 读取本接缝以发送发起请求者自己的密钥。
- [dsh-workspace](../../workspace/workspace/README.zh.md) — 读取本接缝以区分不同用户的工作区。
- [dsh-client-connection](../../client/connection/README.zh.md) — 认证并绑定每个 `/api` 请求的载体。
- [identity 分组地图](../README.zh.md) — 同组包与分组范围。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本接缝不注册工具、提示词分节或会话事件，只决定请求触及哪把凭据与哪些记录。

#### KV 缓存影响

无直接影响：读取本接缝的消费方可能因用户不同而触及不同的路由或记录集，从而改变该消费方构造的请求，而接缝本身不贡献任何 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定接缝到此为止。它们是本包当前的约束，而不是对身份模型的通用比较或任务待办。

- **每套组合只有一个提供方** — 该服务是单一 Cordis 服务，因此两种认证方案无法服务同一棵树。需要两者的部署应在一个同时理解两者的提供方中完成认证。
- **`secret` 是一把凭据，且无类型** — 接缝携带用户用以认证的字符串，对其方案不作任何声明。需要知道自己持有的是 bearer 令牌还是密钥的消费方，必须从与它一同挂载的提供方处得知。
- **绑定跟随异步续体，而非请求** — 请求启动后又有意脱离的工作（定时器、稍后排空的队列）会离开该区域并读不到主体。这对计划性工作是正确的，对任何意外脱离的工作则令人意外。
- **没有吊销信号** — 交给消费方的 `Principal` 在该消费方持有期间一直可用。关闭会话的提供方会停止认证新请求，但无法召回已在途中的绑定。
- **没有任何机制强制 `secret` 卫生** — 约定禁止记录或持久化它，但没有闸门检查消费方是否遵守。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的方向与给维护者的备注。已发布行为与既定理由存放于上文各节与包代码中。

- `models` 放在主体上，是因为随仓库发布的提供方在验证密钥时就得知了它，再发一轮往返去发现它纯属浪费。它是提供方提供的参考性元数据；把它当作授权的消费方，是在重复上游服务无论如何都会做的判断。
- 未发布不变量伴生包：接缝只拥有一个绑定存储，且不发布任何独立观察可能背离的事件序列或可变关系。

</details>

**运行时不变量：** 未发布伴生包。除在自身接缝处强制的约定外，本包不暴露独立的事件序列或可变数据关系。
