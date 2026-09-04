---
description: "Multi-user LiteLLM Web profile bundle for operators running one harness deployment for a team."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-litellm-web`

English | [中文](README.zh.md)

## Summary

The multi-user LiteLLM surface as a `dsh` profile bundle over [`dsh-web-app`](../web-app/README.md). Its patch adds two rows and retargets one: [`dsh-litellm-auth`](../../litellm/litellm-auth/README.md) provides `ctx.principal` so people sign in with a [LiteLLM](https://docs.litellm.ai) virtual key, [`dsh-llm-litellm`](../../llm/llm-litellm/README.md) registers the `litellm` provider route, and new sessions default to a model the proxy serves. Three behaviors follow from the principal row alone: `/api` stops accepting the launch-token browser session and starts accepting a signed-in session, the workspace registry shows each person only their own workspaces, and every model request carries the requester's own key so the proxy applies their access and budget and bills the spend to them.

## Table of Contents

- [Use this package](#use-this-package)
- [Standard deployment workflow](#standard-deployment-workflow)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the bundle to a profile's `dsh.profile.bundles` after `@deepseek-ai/dsh-web-app`, or apply its patch directly:

```sh
export LITELLM_BASE_URL=https://litellm.internal
export DSH_LITELLM_MODEL=gpt-4o
dsh web --patch ./node_modules/@deepseek-ai/dsh-litellm-web/cordis.patch.yml
```

The proxy address is read from the launching environment because it is a deployment fact rather than a user preference; a deployment that prefers to pin it edits the two rows that read it. `DSH_LITELLM_SECURE_COOKIE=1` marks the session cookie `Secure`, which every HTTPS deployment wants and which silently breaks sign-in on plain HTTP. `LITELLM_API_KEY` is the fallback credential for work no signed-in person made — a scheduled job, a CLI run in the same home — and never overrides a signed-in person's key.

A deployment serving people beyond loopback also binds beyond it and declares the authorities it is reached by, both of which are `dsh-web-app` concerns this bundle does not change: bind with `--host 0.0.0.0` and pass `--trusted-host` for each name, because the `/api` Host fence still runs ahead of authentication.

The direct DeepSeek route stays mounted and is left alone. It costs nothing where no key is configured for it, and a deployment that wants both routes available to its people gets that without editing this bundle.

-----

<a id="standard-deployment-workflow"></a>
## Standard deployment workflow

An operator points `LITELLM_BASE_URL` at a proxy that already knows their people, issues each person a virtual key with the models and budget they should have, and launches the profile. Someone opens the surface, is served the application document, and is refused at `/api` until they sign in at `/auth/litellm` with their key. From then on their workspaces, sessions, and model requests are theirs: the proxy sees their key on every call and accounts for it against their budget.

Adding a person is issuing them a key. Removing one is revoking it: their sessions stop working at the proxy on their next request, and their harness session ends at its own expiry. Neither is a harness operation, which is the point — the proxy stays the one place accounts live.

<a id="model-experience"></a>
## Model Experience

### Default route and model

#### What the model sees

The bundle retargets the base's `agent-default-model` row to the `litellm` provider and the alias named by `DSH_LITELLM_MODEL`. The persona and every prompt section come from `dsh-web-app` and `dsh-base` unchanged; nothing here contributes model-visible text.

#### Token effect

None beyond the inherited base and Web-surface sections. The alias selects which upstream model tokenizes the request.

#### KV Cache effect

Stable for a fixed alias. Changing `DSH_LITELLM_MODEL`, or changing which upstream model the proxy routes that alias to, changes the request identity from the first token; two signed-in people using one alias share prefix identity, because only the credential differs and it is transport metadata.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe the composition, not the packages it mounts; each package's own page carries its constraints.

- **`DSH_LITELLM_MODEL` defaults to `gpt-4o`** — a proxy that does not serve that alias fails the first request of a session rather than the launch, because the alias is deployment vocabulary the bundle cannot verify.
- **A restart signs everyone out** — sessions are process-memory only, which is what keeps keys off disk.
- **One process, one proxy** — the bundle mounts one sign-in and one route, so a deployment fronting several proxies needs several profiles.
- **Workspaces created before the bundle was mounted stay unowned** — they remain visible to unattended work in the same harness home and are not shown to signed-in people, because handing a pre-sign-in registry to whoever signs in first is what per-user workspaces exist to prevent.
- **Session logs and attachments share one harness home** — the registry separates what each person *sees*; the durable session data underneath is one tree, so an operator with filesystem access reads everyone's.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above and in the mounted packages.

- Per-user session storage roots are the obvious next step and are a bigger change than they look: the storage backends resolve their roots once at boot, so per-person roots mean either a plugin subtree per person or a principal-aware backend. The registry-level separation shipped here is the honest half of the problem.
- The bundle deliberately does not disable the DeepSeek route. If a future profile wants a proxy-only posture, that is a patch layer over this one rather than a change here.

</details>

**Runtime invariant:** No companion is published. A bundle is a patch layer with no runtime interface; every observable relation it composes is enforced at the seams of the packages it mounts.
