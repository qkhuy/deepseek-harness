---
description: "面向运维者的多用户 LiteLLM Web profile bundle 说明，适用于为一个团队运行同一套 harness 部署。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-litellm-web`

[English](README.md) | 中文

## 概述

多用户 LiteLLM 界面，作为叠加在 [`dsh-web-app`](../web-app/README.zh.md) 之上的 `dsh` profile bundle。其 patch 新增两行并改写一行：[`dsh-litellm-auth`](../../litellm/litellm-auth/README.zh.md) 提供 `ctx.principal`，让人们用 [LiteLLM](https://docs.litellm.ai) 虚拟密钥登录；[`dsh-llm-litellm`](../../llm/llm-litellm/README.zh.md) 注册 `litellm` 提供方路由；新会话默认使用代理服务的某个模型。仅主体那一行就引出三项行为：`/api` 不再接受启动令牌浏览器会话而改为接受已登录会话，工作区注册表只向每个人展示他们自己的工作区，每次模型请求携带发起者自己的密钥，从而由代理执行其访问与预算并把花费记在其名下。

## 目录

- [使用本包](#use-this-package)
- [标准部署流程](#standard-deployment-workflow)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把该 bundle 加入 profile 的 `dsh.profile.bundles`，位于 `@deepseek-ai/dsh-web-app` 之后，或直接应用其 patch：

```sh
export LITELLM_BASE_URL=https://litellm.internal
export DSH_LITELLM_MODEL=gpt-4o
dsh web --patch ./node_modules/@deepseek-ai/dsh-litellm-web/cordis.patch.yml
```

代理地址从启动环境读取，因为它是部署事实而非用户偏好；倾向于固定它的部署可以修改读取它的那两行。`DSH_LITELLM_SECURE_COOKIE=1` 为会话 cookie 标记 `Secure`，这是每套 HTTPS 部署都需要的，也是在纯 HTTP 上会静默破坏登录的。`LITELLM_API_KEY` 是无已登录者发起的工作——计划任务、同一 home 中的 CLI 运行——所用的兜底凭据，绝不覆盖已登录者的密钥。

服务范围超出回环地址的部署也要在回环之外绑定并声明它被访问所用的权威地址，这两点都是本 bundle 不改变的 `dsh-web-app` 事务：用 `--host 0.0.0.0` 绑定，并为每个名称传入 `--trusted-host`，因为 `/api` 的 Host 围栏仍在认证之前运行。

直连 DeepSeek 的路由保持挂载且不作改动。在未为其配置密钥的地方它不产生任何开销，而希望两个路由都对其成员可用的部署无需修改本 bundle 即可获得。

-----

<a id="standard-deployment-workflow"></a>
## 标准部署流程

运维者把 `LITELLM_BASE_URL` 指向一个已经认识其成员的代理，为每个人签发带有应有模型与预算的虚拟密钥，然后启动该 profile。有人打开界面，会收到应用文档，但在 `/auth/litellm` 用密钥登录之前会在 `/api` 处被拒。此后他们的工作区、会话与模型请求都归他们所有：代理在每次调用上看到他们的密钥，并据此计入他们的预算。

新增一个人就是给他签发一把密钥。移除一个人就是吊销它：他们的会话在下一次请求时于代理处停止工作，而其 harness 会话在自身过期时结束。两者都不是 harness 操作，这正是要点——代理仍是账户唯一的存放之处。

<a id="model-experience"></a>
## 模型体验

### 默认路由与模型

#### 模型看到什么

该 bundle 把基础层的 `agent-default-model` 行改指向 `litellm` 提供方以及 `DSH_LITELLM_MODEL` 指名的别名。人设与每个提示词分节均原样来自 `dsh-web-app` 与 `dsh-base`；这里不贡献任何模型可见文本。

#### Token 影响

除继承自基础层与 Web 界面的分节之外没有额外影响。别名决定由哪个上游模型对请求分词。

#### KV 缓存影响

对固定别名保持稳定。更改 `DSH_LITELLM_MODEL`，或更改代理把该别名路由到哪个上游模型，都会从第一个 token 起改变请求身份；使用同一别名的两位已登录者共享前缀身份，因为不同的只有凭据，而它是传输元数据。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述的是该组合本身，而非它挂载的各个包；每个包各自的页面承载其自身约束。

- **`DSH_LITELLM_MODEL` 默认为 `gpt-4o`** — 不服务该别名的代理会让会话的首次请求失败而非启动失败，因为该别名是 bundle 无法验证的部署词汇。
- **重启会让所有人退出登录** — 会话只存在于进程内存中，这正是密钥不落盘的原因。
- **一个进程，一个代理** — 该 bundle 挂载一次登录与一个路由，因此前置多个代理的部署需要多个 profile。
- **挂载该 bundle 之前创建的工作区仍无所有者** — 它们对同一 harness home 中的无人值守工作仍然可见，且不展示给已登录者，因为把登录之前的注册表交给最先登录的人，正是按用户工作区要防止的结果。
- **会话日志与附件共用同一个 harness home** — 注册表分隔的是每个人**看到**什么；其下的持久会话数据是同一棵树，因此具备文件系统访问权限的运维者可以读到所有人的。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的方向与给维护者的备注。已发布行为与既定理由存放于上文各节与所挂载的各个包中。

- 按用户的会话存储根是显而易见的下一步，且比看上去更大：存储后端在启动时一次性解析其根目录，因此按人划分的根要么意味着按人一棵插件子树，要么意味着一个理解主体的后端。本次交付的注册表级分隔是这个问题中诚实的那一半。
- 该 bundle 有意不禁用 DeepSeek 路由。若未来某个 profile 想要纯代理姿态，那应当是叠加在本层之上的 patch 层，而不是在此处改动。

</details>

**运行时不变量：** 未发布伴生包。bundle 是没有运行时接口的 patch 层；它所组合的每一项可观察关系都在其挂载的各个包的接缝处强制。
