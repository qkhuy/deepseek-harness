---
description: "The LiteLLM proxy management client for maintainers verifying virtual keys, reading per-key model catalogs, and classifying proxy failures."
kind: "package-reference"
---

# @deepseek-ai/dsh-litellm-client

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-litellm-client` talks to a [LiteLLM](https://docs.litellm.ai) proxy's management API: it verifies one virtual key and reads who it belongs to, lists the models that key may request, and turns a proxy refusal into the harness's provider-neutral failure codes. Everything here acts *as the caller's key* — there is no admin credential and no ambient process key, because one process serving several signed-in users must never mix their authority. The proxy's own authorization then decides what each key sees, so the harness never reimplements the proxy's access rules. The package is a plain library with no Cordis plugin, no configuration, and no state beyond an endpoint and a timeout.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Depend on this package when a plugin must ask a LiteLLM proxy about a key or the models behind it. Construct one client per endpoint and pass the key at each call:

```ts
import { LiteLlmClient } from '@deepseek-ai/dsh-litellm-client'

declare const submittedKey: string

const client = new LiteLlmClient({ baseURL: 'https://proxy.example', timeoutMs: 15_000 })
const identity = await client.verifyKey(submittedKey)
const models = await client.listModels(submittedKey)
```

### Verify a key and learn who holds it

`verifyKey` asks `/key/info` first, because that endpoint answers for the exact key presented. A proxy that does not expose it — or exposes it only to admin keys, which answers 401 for an ordinary virtual key — falls back to `/user/info`, whose reply names the same user. A key both endpoints refuse raises `LiteLlmRequestError` carrying the `/key/info` verdict, so a sign-in surface can tell "wrong key" from "key with no addressable user"; the latter answers `undefined`.

The returned `LiteLlmKeyIdentity` carries `userId`, and the key itself is never a field: this record travels to configuration surfaces and diagnostics, and a key that reached either would be a leak. A key issued without a user id falls back to its team id and then to its alias, because a caller addressing durable per-user data by this value cannot leave it blank. `models` lists what the key may request, where empty means unrestricted — LiteLLM spells that three ways (an absent list, an empty list, and the `all-proxy-models` wildcard) and all three arrive here as the empty list.

### Read the model catalog a key may use

`listModels` asks `/model/info` first for its capacities and capability flags, then `/v1/models` when the proxy restricts the management endpoint. An empty catalog from both is returned as empty rather than raising, because a proxy may legitimately serve a key no model, and the caller decides whether that is an error. Ids are de-duplicated, since a proxy listing one model under several deployments repeats its public alias.

### Point at a proxy in either documented spelling

LiteLLM's own documentation publishes both `https://proxy.example` and `https://proxy.example/v1` — the OpenAI base URL carries the version segment, the management endpoints do not. `liteLlmApiRoot` resolves both to one API root and `liteLlmChatCompletionsUrl` builds the chat endpoint from either, so a deployment that copied whichever spelling it found reaches both halves.

### Classify a refusal

`classifyLiteLlmFailure(status, body, retryAfter)` reads the proxy's message before its status, because LiteLLM reports both an exceeded budget and an exhausted TPM/RPM allowance as HTTP 400. A caller reading only the status would retry the first forever and give up on the second immediately. The result carries a provider-neutral code — `AUTH`, `QUOTA`, `RATE_LIMIT`, `BAD_REQUEST`, `UNKNOWN_MODEL`, `SERVER`, `TRANSPORT` — plus the status and, when the response carried a usable `Retry-After` in either RFC 9110 spelling, the delay in milliseconds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the client; the observable behavior is fully covered in [Use this package](#use-this-package).

### Parsing narrows, it does not validate

A proxy's `/key/info` payload varies with its database schema and its version, and the same facts appear under `info`, under `user_info`, and flat at the top level depending on the endpoint and the build. Every reader here therefore narrows a candidate document rather than validating a fixed one: a field that is missing, `null`, or the wrong type is absent, and only the one fact a caller cannot proceed without — an addressable user id — turns absence into a refusal.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The client, the URL canon, and the payload readers |
| [`src/failure.ts`](src/failure.ts) | Message-before-status classification and `Retry-After` parsing |
| [`src/types.ts`](src/types.ts) | `LiteLlmKeyIdentity` and `LiteLlmModel` |
| [`tests/client.spec.ts`](tests/client.spec.ts) | Exercised behavior: key verification, fallbacks, catalog reads, URL canon |
| [`tests/failure.spec.ts`](tests/failure.spec.ts) | Exercised behavior: budget and allowance markers, status fallback, retry delays |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the client contract is not enough. They move from this library to the plugins that use it.

- [dsh-litellm-auth](../litellm-auth/README.md) — verifies a submitted key through this client at sign-in.
- [dsh-llm-litellm](../../llm/llm-litellm/README.md) — reads per-user catalogs through this client and streams model calls itself.
- [dsh-litellm-web](../../bundle/litellm-web/README.md) — the profile bundle that mounts both.
- [LiteLLM proxy documentation](https://docs.litellm.ai) — the upstream service and its management API.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package performs management-API reads only and sends no model request.

#### KV Cache effect

None; no request this package makes reaches a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the client stops. They are current package constraints, not a general comparison of proxy clients or a task backlog.

- **No pagination** — `/model/info` and `/v1/models` are read as one page. A proxy serving more models than one response carries is truncated silently.
- **Budget and allowance markers are English substrings** — the classification reads LiteLLM's own wording. A proxy build that rephrases those errors, or localizes them, falls back to the status and loses the `QUOTA`-versus-`RATE_LIMIT` distinction.
- **`expiresAt` is read but not enforced** — the identity carries the key's expiry when the proxy states one; nothing here refuses an expired key, because the proxy refuses it on the next request and that verdict is the authoritative one.
- **No caching** — every call is a request. Callers that read a catalog per model selection cache it themselves.
- **`spend` and `maxBudget` are a snapshot** — both are read at verification time and are stale immediately; they describe the account for a surface, and never gate a request.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above and in the package code.

- The `/key/info` then `/user/info` fallback exists because proxy deployments differ in which management endpoints they expose to ordinary virtual keys. If a future LiteLLM release settles that, the fallback becomes dead weight and should go.
- Nothing here writes to the proxy. Key issuance, budgets, and team membership stay the proxy operator's business, and pulling any of it into the harness would put two systems in charge of one account.

</details>

**Runtime invariant:** No companion is published. This package is a stateless library over HTTP with no independent event sequence or mutable data relation to observe.
