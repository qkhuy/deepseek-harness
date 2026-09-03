---
description: "Package map for the LiteLLM family: the proxy management client, virtual-key sign-in, and how one credential both authenticates a person and pays for their model calls."
kind: "package-group"
---

# litellm/ — LiteLLM sign-in and proxy access

English | [中文](README.zh.md)

## Summary

The `litellm/` group lets several people share one harness deployment, with a [LiteLLM](https://docs.litellm.ai) proxy as the authority on who they are and what they may spend. One credential does both jobs: a virtual key verified against the proxy's management API is what signs a person in, and the same key is what their model requests carry, so the proxy applies their model access and budget and bills the spend to them. It provides the management client that talks to a proxy (`litellm-client/`) and the sign-in plugin that provides the principal seam (`litellm-auth/`). Keys are never written to disk, and no key configured in the environment takes part in a signed-in request.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Two packages provide the LiteLLM feature: one talks to a proxy about keys and models, the other turns a key into a signed-in session. Their READMEs cover day-to-day use; the provider route that sends each person's key lives in the `llm/` group.

| Package | Role | ctx key |
|---|---|---|
| [`litellm-client/`](litellm-client/README.md) | Verify one virtual key, read the models it may use, classify proxy refusals | none (library) |
| [`litellm-auth/`](litellm-auth/README.md) | Sign-in page, session table, and the principal every consumer reads | registers `ctx.principal` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the seam this family provides, then the route that consumes it and the bundle that mounts both.

- [dsh-principal](../identity/principal/README.md) — the authenticated-principal seam `litellm-auth` provides.
- [dsh-llm-litellm](../llm/llm-litellm/README.md) — the provider route that sends the signed-in person's own key.
- [dsh-litellm-web](../bundle/litellm-web/README.md) — the profile bundle that mounts sign-in and the route over the Web surface.
- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.
- [Credentials subsystem reference](../../docs/subsystems/credentials.md) — the credential plane the fallback reference resolves through.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
