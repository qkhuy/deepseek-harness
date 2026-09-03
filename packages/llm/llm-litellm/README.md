---
description: "The LiteLLM provider route for users and maintainers routing model requests through a proxy under each signed-in user's own key."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-litellm

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-litellm` registers the `litellm` provider route on the harness LLM seam and streams every model call through a [LiteLLM](https://docs.litellm.ai) proxy's OpenAI-compatible endpoint. It exists for one behavior a generic gateway adapter cannot provide: **a request is authenticated as the person who made it.** When `ctx.principal` names a signed-in user, that user's own virtual key is the key on the wire, so the proxy enforces their model access and budget and records the spend against them; the configured `apiKeyEnv` reference is the fallback for work no user made — a scheduled job, a CLI run — and never overrides a signed-in user's key. Model discovery follows the same rule, so each person is offered the catalog their own key may use rather than one declared in configuration.

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

Mount this plugin when model requests go through a LiteLLM proxy. The [`dsh-litellm-web`](../../bundle/litellm-web/README.md) bundle mounts it beside sign-in; mount it directly to compose your own profile:

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

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | required | Proxy URL, with or without a `/v1` suffix |
| `apiKeyEnv` | `LITELLM_API_KEY` | Credential reference for requests no signed-in user made; a signed-in key always wins |
| `timeoutMs` | `600000` | Model-request timeout |
| `catalogTimeoutMs` | `15000` | Timeout for each catalog read |
| `catalogTtlSeconds` | `300` | How long a per-user catalog stays cached |
| `defaultContextWindow` | `128000` | Capacity assumed for a model the proxy does not size |
| `headers` | none | Extra headers on every proxy request, for deployment routing |
| `retryPolicy` | normal, 5 retries | Route-owned policy executed by `dsh-llm-retry` |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Know which key a request uses

The precedence is the package's contract and it has exactly two steps. If a principal is bound to the request, its key goes on the wire. Otherwise `apiKeyEnv` is resolved through the credential seam. A request with neither fails with `MISSING_CREDENTIAL`, naming both ways to fix it.

Nothing in configuration can invert that order, which is the point: an operator cannot accidentally make one person's work bill to another's account, and a shared deployment key cannot quietly serve a user whose own key the proxy would have refused.

Mount [`dsh-litellm-auth`](../../litellm/litellm-auth/README.md) to get signed-in users at all; without a principal seam this route behaves like an ordinary configured gateway.

### Know which models each person sees

`listModels` reads the proxy's `/model/info` under the requesting person's key, so the catalog reflects that key's access. Catalogs are cached per principal for `catalogTtlSeconds` — never process-wide, because two people on one proxy legitimately see different catalogs and a shared cache would show whichever of them asked first to everyone after. A proxy that will not list models degrades to an empty catalog with a logged diagnostic rather than failing model selection, and a model a caller names is still requested: the proxy is the authority on whether it serves that model, and it answers when the request arrives.

### Understand failures

Proxy refusals arrive as `LlmError` carrying provider-neutral codes. `AUTH` is a rejected key, `QUOTA` an exceeded budget, `RATE_LIMIT` an exhausted allowance, `UNKNOWN_MODEL` a model the proxy does not serve, and `TRANSPORT` a proxy that could not be reached. LiteLLM reports both an exceeded budget and an exhausted TPM/RPM allowance as HTTP 400, so the classification reads the proxy's message before its status; a caller reading only the status would retry the first forever and give up on the second immediately.

A stream that ends without its terminator fails with `STREAM_CLOSED` rather than reporting a short answer as complete, and an in-stream error object — how LiteLLM reports an upstream failure that appeared after headers were sent — becomes the matching terminal failure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the adapter; the observable behavior is fully covered in [Use this package](#use-this-package).

### Everything a request needs is captured before its first await

`stream` reads the connection facts and resolves the credential before it touches the network, so a settings change mid-request cannot combine one generation's endpoint with another's key. The adapter itself holds no key at all: `resolveApiKey` is a function it is given, called once per request, which is what makes per-user authentication a property of the transport rather than of the mount.

### Blocks are assigned, not carried

Harness blocks are indexed and explicitly opened and closed, while the OpenAI stream interleaves untagged text, reasoning, and tool-call deltas. `BlockWriter` owns that mapping and nothing else does. A channel that reappears after another interrupted it opens a *new* block rather than reopening the closed one, because the harness protocol has no reopen and the transcript must keep the order the model produced.

### Two projections have no direct counterpart

A harness tool result lives inside a user-role message and becomes its own `tool` message on the wire. Reasoning is dropped from requests entirely: no provider LiteLLM fronts accepts its own thinking back as input, and sending it would spend context on tokens the model then re-derives.

### Usage is asked for explicitly

LiteLLM forwards usage on the final chunk only when the caller sets `stream_options.include_usage`. Without it the harness would record every call as zero-cost, so the adapter always sets it. The harness's counts are disjoint while OpenAI's `prompt_tokens` is an aggregate that already includes cached input, so the cached share is subtracted out.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the credential rule, the per-principal catalog cache, registration |
| [`src/adapter.ts`](src/adapter.ts) | The request, the SSE read, and model metadata |
| [`src/serialize.ts`](src/serialize.ts) | Harness messages and tools projected onto the chat-completions body |
| [`src/stream.ts`](src/stream.ts) | Block assignment, finish reasons, and token accounting |
| [`tests/plugin.spec.ts`](tests/plugin.spec.ts) | Exercised behavior: which key a request acts as, which models a person is offered |
| [`tests/adapter.spec.ts`](tests/adapter.spec.ts) | Exercised behavior: the wire request, the streamed response, refusals |
| [`tests/serialize.spec.ts`](tests/serialize.spec.ts) | Exercised behavior: message and tool projection |
| [`tests/stream.spec.ts`](tests/stream.spec.ts) | Exercised behavior: block assignment, finish mapping, usage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the route to the seam it registers on and the identity it reads.

- [dsh-llm service](../llm/README.md) — the provider-neutral service this adapter registers on.
- [dsh-principal](../../identity/principal/README.md) — the seam that names the requesting person.
- [dsh-litellm-auth](../../litellm/litellm-auth/README.md) — the provider that signs people in and binds them.
- [dsh-litellm-client](../../litellm/litellm-client/README.md) — the management client behind catalog reads.
- [dsh-llm-retry](../llm-retry/README.md) — the retry executor that applies this route's policy.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.
- [dsh-litellm-web](../../bundle/litellm-web/README.md) — the profile bundle that mounts this route.

-----

<a id="model-experience"></a>
## Model Experience

### Provider request through the proxy

#### What the model sees

The selected model receives the system prompt as its own `system` message, the conversation in request order, and the tool schemas the request offered. A tool result arrives as a `tool` message correlated by call id, with a failed result prefixed `Error:` because the wire has no other field for it. Reasoning content from history is not sent. An image block the runtime did not project to text is named by its attachment id rather than dropped, so the model can tell that something was present.

#### Token effect

Provider tokenization governs exact input, and LiteLLM forwards the request to whichever upstream model the alias names. Dropped reasoning removes those tokens from every later request. A named image contributes its descriptor text only.

#### KV Cache effect

Conversion preserves logical request order, so a stable prefix stays stable. Changing the model alias, the proxy route behind it, or any earlier message has the usual suffix effect. Because reasoning is never re-sent, a turn that produced reasoning does not lengthen the next request's prefix.

### Provider response

#### What the model sees

Stream deltas become harness reasoning, text, tool-call, usage, and finish chunks. Tool-call arguments pass through as the raw JSON strings the model produced. A `content_filter` finish is recorded as a normal stop, because the upstream provider completed the call and the response it produced is what the turn is.

#### Token effect

Generated content affects later inputs only after the loop records it. Cached input reported by the proxy is subtracted out of the input count and reported separately, so billed input is the sum of the disjoint counts.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Usage accounting and transport metadata do not affect cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the route stops. They are current package constraints, not a general LiteLLM comparison or a task backlog.

- **No image input on the wire** — an image block reaches the model as its attachment id in text. The proxy's `image_url` content parts are not built, so a vision model behind the proxy sees a description rather than the picture.
- **No replay state** — the adapter stores no provider-native response metadata, so a provider that could resume from its own state re-reads the conversation instead.
- **No request-image pricing** — the token meter falls back to its own neutral estimate for this route.
- **A catalog read costs a request per person per TTL** — a deployment with many signed-in people and a short `catalogTtlSeconds` puts steady load on `/model/info`.
- **Cached catalogs are not invalidated by the proxy** — a key granted a new model waits out `catalogTtlSeconds` before the surface offers it.
- **`defaultContextWindow` is a guess** — a model the proxy does not size is assumed to hold this much, and a wrong guess is discovered as a provider refusal rather than as a local check.
- **Budget and allowance classification reads English proxy messages** — a proxy build that rephrases those errors falls back to the HTTP status and loses the `QUOTA`-versus-`RATE_LIMIT` distinction, which changes whether the retry executor tries again.
- **One route per mount** — the route name is fixed, so two proxies cannot both be reached by mounting this plugin twice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above and in the package code.

- Image support is the largest gap and is mostly mechanical: the projection already knows which blocks are images, and the missing half is resolving attachment bytes and emitting `image_url` parts under a per-model capability check.
- The catalog cache is keyed by principal id and cleared on unmount. It is deliberately not keyed by key hash: two sessions of one person share a catalog, which is what a person expects, and a key rotated mid-session is picked up at the next TTL boundary.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
