---
description: "LiteLLM 家族的包地图：代理管理客户端、虚拟密钥登录，以及同一把凭据如何既完成身份认证又为其模型调用付费。"
kind: "package-group"
---

# litellm/ — LiteLLM 登录与代理访问

[English](README.md) | 中文

## 概述

`litellm/` 分组让多人共用同一套 harness 部署，并以 [LiteLLM](https://docs.litellm.ai) 代理作为「他们是谁、可以花多少」的权威。一把凭据同时干两件事：经代理管理 API 验证过的虚拟密钥就是此人登录所用的东西，而同一把密钥也是其模型请求所携带的，因此代理执行他们的模型访问与预算，并把花费记在他们名下。它提供与代理通话的管理客户端（`litellm-client/`），以及提供主体接缝的登录插件（`litellm-auth/`）。密钥绝不写入磁盘，环境中配置的任何密钥都不参与已登录用户的请求。

## 目录

- [各包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 各包

两个包提供 LiteLLM 功能：一个就密钥与模型与代理通话，另一个把密钥变成已登录会话。它们各自的 README 覆盖日常使用；发送每个人密钥的提供方路由位于 `llm/` 分组。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`litellm-client/`](litellm-client/README.zh.md) | 验证一把虚拟密钥、读取它可用的模型、归类代理拒绝 | 无（库） |
| [`litellm-auth/`](litellm-auth/README.zh.md) | 登录页、会话表，以及每个消费方读取的主体 | 注册 `ctx.principal` |

-----

<a id="related-documentation"></a>
## 相关文档

先看本家族提供的接缝，再看消费它的路由以及挂载两者的 bundle。

- [dsh-principal](../identity/principal/README.zh.md) — `litellm-auth` 提供的已认证主体接缝。
- [dsh-llm-litellm](../llm/llm-litellm/README.zh.md) — 发送已登录者自己密钥的提供方路由。
- [dsh-litellm-web](../bundle/litellm-web/README.zh.md) — 把登录与路由挂载到 Web 界面之上的 profile bundle。
- [能力接缝](../../docs/capability-seams.zh.md) — 本家族遵循的服务定义／服务提供方／消费方划分。
- [凭据子系统参考](../../docs/subsystems/credentials.zh.md) — 兜底引用所经过的凭据平面。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
