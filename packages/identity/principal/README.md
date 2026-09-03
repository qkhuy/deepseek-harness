---
description: "The authenticated-principal seam for maintainers wiring who a request belongs to through the plugins that must act as that user."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-principal` is the Service Definition for one question: whose work is this? A provider answers it at the HTTP carrier, where a request arrives carrying an identity; consumers ask it far from there, inside a model adapter choosing which key to send or a registry deciding which records are visible. The seam bridges that distance with an `AsyncLocalStorage` binding, so a plugin reads the current user without a parameter threaded through seams that have no business naming one. Absence is the shipped local posture and is meaningful: with no provider mounted the service is simply not there, `ctx.get('principal')` answers `undefined`, and every consumer keeps its single-operator behavior unchanged.

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

Depend on this package when a plugin's behavior differs per end user, or when you are writing the provider that authenticates them. It publishes types and one abstract service; it mounts nothing and has no configuration.

### Read the current user

A consumer treats the seam as optional, because the single-operator composition does not mount it:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-principal'

declare const ctx: Context

const principal = ctx.get('principal')?.current()
if (principal !== undefined) {
  // act as this user
}
```

`current()` answers the principal bound to the calling async region, or `undefined` outside every region. `require(consumer)` is the same read for a plugin whose behavior is undefined without a user: it throws `PrincipalRequiredError` naming the consumer that needed one, instead of failing later and further away.

A `Principal` carries four fields. `id` is the stable address of that user's durable data — a per-user directory, a record's owner column — so it never changes for the life of the account and is never the credential. `displayName` is for UI surfaces only. `secret` is the credential the user authenticated with, retained so downstream calls act as them; it is memory-only, and no consumer may log it, write it to a session event, or place it in a durable record. `models` lists the model ids the user may request, where an empty array states the provider imposes no restriction rather than that nothing is allowed.

### Write a provider

A provider extends `PrincipalService` and implements two members. `authenticate(request)` resolves the user behind one inbound request and is synchronous by contract: the carrier answers a request before any handler runs, so a provider keeps whatever it needs — a signing secret, a live session table — loaded ahead of time rather than reaching for it per request. `required` states whether unauthenticated requests must be refused, which lets one deployment add sign-in without locking itself and another refuse everything anonymous.

The binding half is concrete on the seam rather than left to providers, and a provider does not override it.

### Bind a user to a region

A carrier binds once, around everything the request starts:

```ts
import type { Principal, PrincipalService } from '@deepseek-ai/dsh-principal'

declare const principals: PrincipalService
declare const principal: Principal
declare function handleRequest(): Promise<void>

principals.run(principal, async () => {
  await handleRequest()
})
```

Everything `handleRequest` awaits reads the same principal, including a session turn that outlives the response, because the binding follows the async continuation chain rather than the HTTP exchange. Nesting is legal and the innermost binding wins.

### Address durable data by a principal

`principalId(value)` brands a string after checking it against a narrow grammar: a lowercase identifier of at most 128 characters, no dots and no separators. The grammar is narrow because the value is used as a path segment and a storage key, so no id can traverse out of a per-user root or collide under a case-insensitive filesystem. `isPrincipalIdName(value)` asks the same question without throwing, for a provider deriving an id from an upstream account id or a token claim.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the seam; the observable behavior is fully covered in [Use this package](#use-this-package).

### Why the binding is not provider-owned

Two providers each holding their own `AsyncLocalStorage` would each be invisible to the other's consumers: a consumer reads through the service it resolved, and a binding made in one store cannot be seen through the other. The store is therefore the seam's identity, not an implementation choice, and it lives on the abstract class. Providers implement authentication alone, which is the part that genuinely varies.

### Why authentication is synchronous

The carrier decides whether to accept a request before dispatching it, on a code path that has no useful place to await. Making the method synchronous pushes the cost where it belongs: a provider that needs a secret or a session table loads it during activation and answers from memory.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The abstract service, the id brand, and `PrincipalRequiredError` |
| [`src/types.ts`](src/types.ts) | `Principal`, `PrincipalId`, and the carrier-neutral `PrincipalRequest` |
| [`tests/principal.spec.ts`](tests/principal.spec.ts) | Exercised behavior: id grammar, binding isolation, nesting, authentication |
| [`tests/memory.ts`](tests/memory.ts) | Header-token provider double for seam and consumer tests |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the seam contract is not enough. They move from the seam to its shipped provider and the consumers that read it.

- [dsh-litellm-auth](../../litellm/litellm-auth/README.md) — the shipped provider, backed by LiteLLM virtual keys.
- [dsh-llm-litellm](../../llm/llm-litellm/README.md) — reads the seam to send the requesting user's own key.
- [dsh-workspace](../../workspace/workspace/README.md) — reads the seam to separate one user's workspaces from another's.
- [dsh-client-connection](../../client/connection/README.md) — the carrier that authenticates and binds each `/api` request.
- [identity group map](../README.md) — the sibling packages and group scope.

-----

<a id="model-experience"></a>
## Model Experience

None, as the seam registers no tool, prompt section, or session event and only decides which credential and which records a request reaches.

#### KV Cache effect

None directly: a consumer reading the seam may reach a different route or record set per user, which changes the request that consumer builds, while the seam itself contributes no tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the seam stops. They are current package constraints, not a general comparison of identity models or a task backlog.

- **One provider per composition** — the service is a single Cordis service, so two authentication schemes cannot serve one tree. A deployment needing both authenticates in one provider that understands both.
- **`secret` is one credential, untyped** — the seam carries the string a user authenticated with and says nothing about its scheme. A consumer that needs to know whether it holds a bearer token or a key must learn that from the provider it was mounted beside.
- **A binding follows async continuations, not requests** — work a request starts and deliberately detaches from (a timer, a queue drained later) leaves the region and reads no principal. That is correct for scheduled work and surprising for anything that detaches by accident.
- **No revocation signal** — a `Principal` handed to a consumer stays usable for as long as that consumer holds it. A provider that closes a session stops authenticating new requests but cannot recall a binding already in flight.
- **Nothing enforces `secret` hygiene** — the contract forbids logging or persisting it, and no gate checks that consumers obey.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above and in the package code.

- `models` is on the principal because the shipped provider learns it while verifying the key, and a second round trip to discover it would be pure cost. It is provider-supplied advisory metadata; a consumer that treats it as authorization is duplicating a decision the upstream service will make anyway.
- No invariant companion is published: the seam owns one binding store and publishes no event sequence or mutable relation that an independent observation could diverge from.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its own seam.
