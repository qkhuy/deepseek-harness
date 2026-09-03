/**
 * The sign-in page this package serves.
 *
 * It is host-rendered rather than a client plugin so that sign-in never
 * depends on the application bundle: the browser reaches this page before any
 * `/api` request has been authorized, and a login form that needed the SPA
 * would need the SPA to load unauthenticated.
 *
 * @module @deepseek-ai/dsh-litellm-auth/src/login-page
 */

/** Escape the five characters that could close an attribute or open an element. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** What the rendered page must state. */
export interface LoginPageView {
  /** Absolute path the form posts to. */
  readonly action: string
  /** Path to return to after a successful sign-in, already validated as same-origin. */
  readonly next: string
  /** Failure to show above the form, when a previous attempt was refused. */
  readonly error?: string
}

/**
 * Render the sign-in page.
 * @param view - form action, post-sign-in destination, and any refusal to show.
 * @returns the complete HTML document.
 */
export function renderLoginPage(view: LoginPageView): string {
  const error = view.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(view.error)}</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — DeepSeek Harness</title>
<style>
:root { color-scheme: light dark; --fg: #16181d; --bg: #f6f7f9; --card: #ffffff; --line: #d8dce3; --accent: #2f6feb; --err: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8eaed; --bg: #16181d; --card: #1e2127; --line: #333842; --accent: #6c9dff; --err: #ff9a92; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; }
form { width: 100%; max-width: 27rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { margin: 0 0 4px; font-size: 1.25rem; }
p.lede { margin: 0 0 20px; opacity: 0.72; }
label { display: block; font-weight: 600; margin-bottom: 6px; }
input { width: 100%; padding: 10px 12px; font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button { margin-top: 18px; width: 100%; padding: 10px 12px; font: inherit; font-weight: 600; color: #fff;
  background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
p.error { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; color: var(--err);
  border: 1px solid currentColor; background: transparent; }
p.hint { margin: 16px 0 0; font-size: 0.85rem; opacity: 0.66; }
</style>
</head>
<body>
<form method="post" action="${escapeHtml(view.action)}">
<h1>Sign in</h1>
<p class="lede">Use your LiteLLM virtual key. It authenticates you here and is the key your model requests are billed to.</p>
${error}
<input type="hidden" name="next" value="${escapeHtml(view.next)}">
<label for="api-key">LiteLLM virtual key</label>
<input id="api-key" name="apiKey" type="password" autocomplete="current-password" spellcheck="false" autofocus
  placeholder="sk-…" required>
<button type="submit">Sign in</button>
<p class="hint">Your key is held in this server's memory for the life of your session and is never written to disk.</p>
</form>
</body>
</html>
`
}
