# Agent Note: Per-user identity over LiteLLM

Status: implemented

English | [中文](2026-09-03-per-user-identity-over-litellm.zh.md)

## Problem

The Web surface is built for one operator. It binds to loopback, authenticates a browser with a launch token this process printed, keeps one global workspace registry, and sends one configured provider key on every model request. A team that wants to share one deployment therefore shares everything that matters: one person's workspaces are every person's workspaces, and every person's model spend lands on one account. Nothing in the harness could tell two users apart, because nothing in the harness had a concept of a user at all.

Meanwhile, deployments that front several model providers already run a [LiteLLM](https://docs.litellm.ai) proxy, which does have that concept: it issues virtual keys, knows which models each key may request, enforces a budget per key, and accounts for the spend. Every fact a multi-user harness needs already exists there.

## Decision

There is one identity in the system and the proxy owns it. A LiteLLM virtual key is both the credential someone signs in with and the credential their model requests carry, and the harness adds no account system of its own.

Four packages carry that:

- **`dsh-principal`** (`packages/identity/principal`) is the Service Definition for "whose work is this". A provider implements `authenticate(request)` — synchronous, because the carrier answers a request before any handler runs — and `required`. The `AsyncLocalStorage` binding is concrete on the abstract class rather than provider-owned: two providers with two stores would each be invisible to the other's consumers, so the store is the seam's identity. `PrincipalId` is branded through a narrow grammar (lowercase, no dots, no separators, ≤128 chars) because it addresses a path segment and a storage key.
- **`dsh-litellm-client`** (`packages/litellm/litellm-client`) is the proxy management client. Every method takes the key it should act as; there is no admin credential and no ambient process key, because one process serving several signed-in users must never mix their authority.
- **`dsh-litellm-auth`** (`packages/litellm/litellm-auth`) is the principal provider: a host-rendered sign-in page at `/auth/litellm`, an in-memory session table, and the routes a browser signs in through.
- **`dsh-llm-litellm`** (`packages/llm/llm-litellm`) is the `litellm` provider route. Its credential rule is the package's contract: the bound principal's key, else the configured `apiKeyEnv` reference for work no user made. Configuration cannot invert that order.

`dsh-litellm-web` (`packages/bundle/litellm-web`) mounts the three over `dsh-web-app`.

Two shipped packages change to read the seam:

- **`dsh-client-connection`** — a mounted principal seam *replaces* the launch-token browser session rather than layering over it. The two answer different questions ("is this the browser this process opened" and "which user is this"), and a multi-user deployment cannot distribute a launch token, so requiring both would make every user but the operator unreachable. The index is then served unauthenticated, because the sign-in page is a document the browser must reach before it has any identity and every authority it could exercise lives behind `/api`. `runAuthenticated` binds the request's user around dispatch, so a session turn the request starts keeps the binding through every await it makes.
- **`dsh-workspace`** — records carry an `owner`, the registry stamps it at create, and `get`, `list`, and `resolveByPath` filter by the bound principal. Reuse of an existing registration is per owner, so two users opening one directory each get their own workspace rather than sharing one account of sessions. The domain version moves 2 → 3.

The visibility rule is deliberately asymmetric. With no principal bound — no seam, or work no request started — every record is visible, which is the single-operator behavior the registry has always had. With a principal bound, only that principal's records are visible, and an **unowned record is not among them**. Sharing pre-sign-in records with every signed-in user is exactly the outcome per-user workspaces exist to prevent, so a registry that predates sign-in keeps its records for the unauthenticated CLI.

## Sessions hold keys, so sessions do not persist

A session is an opaque 256-bit random token in a table in this process's memory. There is no signed payload, because a value only ever compared against a table entry carries no claims to forge. The consequence is that restarting the harness signs everyone out, and that is the accepted cost: a durable session would have to durably hold each user's LiteLLM key to keep serving their requests after a restart, and nothing here writes a key to disk.

## Alternatives considered

**Configure LiteLLM as a hand-declared route on `dsh-llm-pi-ai`.** That adapter already speaks `openai-completions` to arbitrary gateways, so reaching a LiteLLM proxy needs no new code at all — and it is the right answer for a single-operator deployment. It cannot be the answer here, because its credential comes from `apiKeyEnv` through the credential seam, which is per deployment and not per request. The whole point of this change is a key that varies with who is asking.

**Make the credential seam principal-aware instead of the adapter.** A `CredentialProvider` that answered the current principal's key for configured references would give every adapter per-user authentication with no adapter changes, which is genuinely attractive. It was rejected because `credentials` is one Cordis service: the principal-aware provider would have to wrap and replace `credentials-local`, so a deployment could not choose per-user routing for one provider and a deployment key for another, and a reference silently resolving to different values per caller is exactly the implicit defaulting `AGENTS.md` forbids at package boundaries.

**Layer sign-in on top of the existing browser-session cookie.** Keeping both would mean a user needs the launch token *and* a virtual key. The launch token is printed once, to the operator's terminal, and cannot be distributed; requiring it would leave the feature unusable by everyone it is for.

**Per-user storage roots instead of per-record owners.** Separating the durable trees — `sessions/`, `storages/`, attachments — would be stronger than filtering a shared registry. The storage backends resolve their roots once at boot from `dshHomePath(...)`, so per-user roots mean either a plugin subtree per signed-in user or a principal-aware backend, both larger than this change. Record-level ownership is the honest half and is what shipped; the remaining half is named in Consequences.

**A client-side sign-in view.** The React application cannot load before `/api` accepts the request, so a login form built into it would need the bundle served unauthenticated anyway. A host-rendered page loads with nothing, at the cost of ignoring the theme and locale plugins.

## Consequences

What it bought: a shared deployment where each person's workspaces are their own, and where the proxy — not the harness — enforces which models they may use and what they may spend, with the spend recorded against them. Adding a person is issuing them a key; removing one is revoking it. Neither is a harness operation, so the proxy stays the one place accounts live.

What it cost:

- **A restart signs everyone out**, which is the price of never writing a key to disk.
- **Sessions do not survive a second process.** Two harness processes behind one address do not share the table. The Web surface is one process today; this becomes real the moment it is not.
- **Durable session data is still one tree.** The registry separates what each person *sees*; session logs and attachments underneath share a harness home, so an operator with filesystem access reads everyone's. Per-user storage roots remain the open half of the problem.
- **A key valid at sign-in is trusted for the session.** The proxy is asked once. A key revoked afterwards keeps authenticating here until its session ends, and the refusal then arrives from the proxy on the user's next model request.
- **Workspace domain v3 rejects a v2 medium.** Pre-release stance: backends reject old on-disk formats, so an existing registry is discarded rather than migrated.
- **`dsh-client-connection` now has two authentication postures.** A composition that mounts a principal provider gets multi-user behavior implicitly, which is the point but is also a large behavior change from one mounted row.

## Testing

`tests/routes.spec.ts` in `dsh-litellm-auth` drives real HTTP against a real webserver with a scripted proxy behind the key check, covering sign-in, refusals, the JSON form, sign-out, and session expiry. `tests/plugin.spec.ts` in `dsh-llm-litellm` is where the credential rule is proven: a bound principal's key reaches the proxy while the configured reference does not, an unbound request uses the reference, and two principals receive their own catalogs. `tests/per-user.spec.ts` in `dsh-workspace` covers stamping, per-owner listing, per-owner reuse of one directory, survival across a restart, and the unowned-record rule. `tests/principal-gate.host.spec.ts` in `dsh-client-connection` covers the replaced posture, the unauthenticated index, and that the binding is live inside an `/api` handler.

No recorded-session snapshot changes: nothing here alters model-visible content. The route's own wire behavior is covered by `tests/adapter.spec.ts` against a scripted SSE proxy rather than by a real-API e2e, because a LiteLLM proxy is not part of the CI environment.
