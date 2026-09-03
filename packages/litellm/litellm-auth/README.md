---
description: "LiteLLM virtual-key sign-in for users and operators running the Web surface for more than one person."
kind: "package-reference"
---

# @deepseek-ai/dsh-litellm-auth

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-litellm-auth` makes the Web surface multi-user by letting people sign in with a [LiteLLM](https://docs.litellm.ai) virtual key. One credential does both jobs: the key is verified against the proxy's own management API, which is what authenticates the person to this harness — there is no second account system — and the same key is then held in their session so every model request they make is authorized, budgeted, and billed to them by the proxy. Mounting the plugin provides `ctx.principal`, and three things follow from that: `/api` starts refusing unauthenticated requests, the workspace registry separates each person's workspaces from everyone else's, and model requests carry the requester's own key rather than any key configured in the environment. Keys are never written to disk.

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

Mount this plugin when more than one person uses one harness deployment and a LiteLLM proxy already decides who they are and what they may spend. The [`dsh-litellm-web`](../../bundle/litellm-web/README.md) bundle mounts it for you; mount it directly to compose your own profile:

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

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | required | Proxy URL, with or without a `/v1` suffix. There is no default: guessing one would send a user's key somewhere they did not name |
| `sessionTtlMinutes` | `720` | Session lifetime from sign-in |
| `verifyTimeoutMs` | `15000` | Timeout for each key-verification call |
| `cookieName` | `dsh-litellm-session` | Session cookie name |
| `secureCookie` | `false` | Whether to mark the cookie `Secure` |
| `requireLogin` | `true` | Whether unauthenticated requests are refused |
| `headers` | none | Extra headers on each proxy management call, for deployment routing |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Sign in

The plugin serves its own sign-in page at `/auth/litellm`, host-rendered rather than built into the application bundle: the browser reaches it before any `/api` request has been authorized, and a login form that needed the application would need the application to load unauthenticated. Someone types their virtual key, the plugin verifies it against the proxy, and a successful verification opens a session and returns them to where they were headed.

A refusal says which kind it is, because the two have different fixes: a key the proxy rejects is the person's to correct, while a proxy that cannot be reached is the operator's. A key the proxy accepts but names no user for is refused too — the harness addresses that person's workspaces by their proxy user id, and cannot pool such keys under a shared fallback.

### Sign in programmatically

A client that sends `Content-Type: application/json` gets JSON instead of a redirect. `POST /auth/litellm` with `{"apiKey": "sk-…"}` answers the session view — principal id, display name, and permitted models, never the key — and sets the same cookie. `GET /auth/litellm/session` answers that view for the current session or 401, and `POST /auth/litellm/logout` closes it.

### Understand what a session is

A session is an opaque 256-bit random token held in this process's memory, looked up in a table. There is no signed payload to forge, and the consequence is deliberate: **restarting the harness signs everyone out.** The alternative — a durable signed cookie — would have to durably hold each person's LiteLLM key to keep serving their requests after a restart, and this package never writes a key to disk. Signing in from a second browser adds a session rather than replacing the first, so one person can work from two places.

### Choose a posture

`requireLogin: true` refuses every unauthenticated `/api` request, which is the posture for a shared deployment. `requireLogin: false` keeps the surface open and binds a user only to requests that carry a session, which is how to add sign-in to a single-operator deployment without locking it while people migrate.

Set `secureCookie` wherever the surface is served over HTTPS. Leaving it set on a plain-HTTP deployment makes every sign-in silently fail to stick, because the browser refuses to store a `Secure` cookie there.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the plugin; the observable behavior is fully covered in [Use this package](#use-this-package).

### The principal id is derived, never the proxy's own

A LiteLLM user id is whatever its operator issued — a UUID, an email address, an SSO subject — while a principal id addresses a directory and a storage key, so the two vocabularies cannot be the same string. `principalIdForLiteLlmUser` joins a readable slug of the proxy id to a 64-bit digest of that id in full. The slug alone would collide (`alice@a.com` and `alice@b.com` reduce to the same characters) and the digest alone would make every per-user directory unreadable, so both are kept and the digest carries the uniqueness. The derivation is a pure function, because the id addresses durable data: the same proxy user must resolve to the same principal on every sign-in, in every process, for the life of the account.

### Routes sit below the trust fence, not behind it

The sign-in routes register directly on `webServer` rather than on the `/api` channel, because `/api` is exactly what a person cannot reach until they have signed in. They are exact paths, so they never shadow the application's own routing.

### The return path is reduced before it is used

Only a rooted same-origin path survives `safeReturnPath`; anything starting with `//`, carrying a scheme, or containing a backslash becomes `/`. An open redirect here would turn the sign-in page into a credible launch point for a phishing link. The reduction is silent, because someone who followed a tampered link should land on the application rather than read about it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the principal provider, and the three routes |
| [`src/session.ts`](src/session.ts) | The session table and the cookie encoding |
| [`src/principal-id.ts`](src/principal-id.ts) | Stable derivation of a principal id from a proxy user id |
| [`src/http.ts`](src/http.ts) | Body reading, return-path reduction, and the response forms |
| [`src/login-page.ts`](src/login-page.ts) | The host-rendered sign-in page |
| [`tests/routes.spec.ts`](tests/routes.spec.ts) | Exercised behavior: real HTTP against a scripted proxy |
| [`tests/session.spec.ts`](tests/session.spec.ts) | Exercised behavior: cookies, expiry, sweeping, id derivation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the provider to the seam it implements and the consumers that read it.

- [dsh-principal](../../identity/principal/README.md) — the seam this plugin provides.
- [dsh-litellm-client](../litellm-client/README.md) — the management client that verifies each key.
- [dsh-llm-litellm](../../llm/llm-litellm/README.md) — sends the signed-in person's key on every model request.
- [dsh-workspace](../../workspace/workspace/README.md) — separates each person's workspaces by principal.
- [dsh-litellm-web](../../bundle/litellm-web/README.md) — the profile bundle that mounts this plugin.
- [dsh-client-connection](../../client/connection/README.md) — the carrier whose authentication this plugin replaces.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no tool, prompt section, or session event and only decides which credential a later model request carries.

#### KV Cache effect

None directly: two people signed into one deployment reach the same models through the same requests, and only the credential on the wire differs, which is transport metadata.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where sign-in stops. They are current package constraints, not a general comparison of authentication schemes or a task backlog.

- **A restart signs everyone out** — sessions live in process memory, which is what keeps keys off disk. Every signed-in person types their key again after a deploy.
- **Sessions do not survive a second process** — two harness processes behind one address do not share the table, so a person is signed in to whichever one they reach. The Web surface is a single process today, and this becomes real the moment it is not.
- **Session lifetime is absolute, not sliding** — `sessionTtlMinutes` runs from sign-in and is not extended by activity, so someone working past the boundary is signed out mid-task.
- **Sign-in is not rate limited** — the plugin refuses a wrong key and says so; it does not slow repeated attempts. A deployment reachable beyond a trusted network wants that in front of it.
- **A key valid at sign-in is trusted for the session** — the proxy is asked once. A key revoked, expired, or re-budgeted afterwards keeps authenticating here until its session ends, and the refusal then comes from the proxy on the person's next model request rather than from the sign-in surface.
- **One proxy per deployment** — `baseURL` is one endpoint. A deployment fronting several proxies cannot present them as one sign-in.
- **No client UI** — the sign-in page is host-rendered and is not themed by the application's own locale or theme plugins.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above and in the package code.

- Durable sessions keep coming up, and every version of it needs somewhere to keep the person's key. Encrypting it under a harness-home secret only moves the problem to whoever can read the home. A refresh-token exchange with the proxy would solve it properly, and LiteLLM does not offer one today.
- The sign-in page being host-rendered is a deliberate trade: it loads without the application bundle, and it therefore ignores the theme and locale plugins. If a client-side sign-in view is ever built, this page must stay as the fallback for a surface whose bundle cannot load.

</details>

**Runtime invariant:** No companion is published. The session table is process-private with no independent observation point, and the identity it publishes is enforced at the `dsh-principal` seam.
