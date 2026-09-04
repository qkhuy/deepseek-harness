/**
 * The sign-in surface as a browser and a programmatic client see it: a real
 * webserver, real HTTP, and a scripted LiteLLM proxy behind the key check.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LiteLlmClient, LiteLlmRequestError } from '@deepseek-ai/dsh-litellm-client'
import { LOGIN_PATH, LOGOUT_PATH, SESSION_PATH, internals } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import * as LiteLlmAuth from '../src/index.ts'
import { requestUrl } from '../../litellm-client/tests/request-url.ts'

let context: Context | undefined
const createClient = internals.createClient

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  internals.createClient = createClient
})

/** A proxy that answers /key/info for exactly the keys it was given. */
function scriptProxy(keys: Record<string, unknown>, transportFailure = false): void {
  const fetchImpl: typeof globalThis.fetch = (input) => {
    if (transportFailure) return Promise.reject(new Error('ECONNREFUSED'))
    const url = new URL(requestUrl(input))
    if (url.pathname !== '/key/info' && url.pathname !== '/user/info') {
      return Promise.resolve(new Response('{}', { status: 404 }))
    }
    return Promise.resolve(new Response('{"error":{"message":"Invalid proxy server token"}}', { status: 401 }))
  }
  internals.createClient = options => new LiteLlmClient({
    ...options,
    fetch: (input, init) => {
      const key = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
      const info = keys[key]
      if (info === undefined) return fetchImpl(input, init)
      return Promise.resolve(new Response(JSON.stringify({ info }), { status: 200 }))
    },
  })
}

async function boot(config: Partial<Config> = {}): Promise<number> {
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(LiteLlmAuth, { baseURL: 'https://proxy.example', ...config })
  return context.webServer.port
}

const url = (port: number, path: string): string => `http://127.0.0.1:${String(port)}${path}`

/** Sign in with a form post and hand back the session cookie the browser would keep. */
async function signIn(port: number, apiKey: string, next = '/'): Promise<Response> {
  return await fetch(url(port, LOGIN_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ apiKey, next }),
    redirect: 'manual',
  })
}

function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie')
  expect(header).not.toBeNull()
  return header!.split(';')[0]!
}

describe('internals.createClient', () => {
  it('builds a real LiteLlmClient by default', () => {
    expect(createClient({ baseURL: 'https://proxy.example', timeoutMs: 1000 })).toBeInstanceOf(LiteLlmClient)
  })
})

describe('the sign-in page', () => {
  it('is reachable with no identity at all', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('LiteLLM virtual key')
  })

  it('refuses methods it does not serve', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), { method: 'DELETE' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })

  it('carries a same-origin return path into the form and drops an off-origin one', async () => {
    scriptProxy({})
    const port = await boot()
    expect(await (await fetch(url(port, `${LOGIN_PATH}?next=/w/1`))).text()).toContain('value="/w/1"')
    expect(await (await fetch(url(port, `${LOGIN_PATH}?next=//evil.example`))).text()).toContain('value="/"')
  })
})

describe('signing in with a virtual key', () => {
  it('accepts a key the proxy knows and returns to the requested path', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice@example.com', key_alias: 'laptop', models: ['gpt-4o'] } })
    const port = await boot()
    const response = await signIn(port, 'sk-alice', '/w/1')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/w/1')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('will not redirect off this origin after sign-in', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    expect((await signIn(port, 'sk-alice', 'https://evil.example')).headers.get('location')).toBe('/')
  })

  it('refuses a key the proxy rejects, and mints no session', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await signIn(port, 'sk-wrong')
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toContain('refused by the LiteLLM proxy')
  })

  it('names the operator problem when the proxy cannot be reached', async () => {
    scriptProxy({}, true)
    const port = await boot()
    const response = await signIn(port, 'sk-alice')
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('could not be reached')
  })

  it('refuses an empty key without asking the proxy', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await signIn(port, '   ')
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Enter your LiteLLM virtual key')
  })

  it('refuses a key the proxy accepts but names no user for', async () => {
    scriptProxy({ 'sk-nameless': {} })
    const port = await boot()
    expect((await signIn(port, 'sk-nameless')).status).toBe(403)
  })

  it('refuses a cross-site submission and mints no session — the login-CSRF attack', async () => {
    // Simulates an attacker page auto-submitting a real cross-origin form post
    // with the attacker's own valid key: a browser marks that navigation
    // cross-site, and the server must refuse it before it ever opens a
    // session in the victim's browser.
    scriptProxy({ 'sk-attacker': { user_id: 'attacker', models: [] } })
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
      body: new URLSearchParams({ apiKey: 'sk-attacker', next: '/' }),
      redirect: 'manual',
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a cross-site JSON submission with a JSON error body', async () => {
    scriptProxy({ 'sk-attacker': { user_id: 'attacker', models: [] } })
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ apiKey: 'sk-attacker', next: '/' }),
      redirect: 'manual',
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toEqual({ error: 'Cross-site sign-in requests are refused.' })
  })

  it('refuses a submission whose Origin does not name this server', async () => {
    scriptProxy({ 'sk-attacker': { user_id: 'attacker', models: [] } })
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'https://evil.example' },
      body: new URLSearchParams({ apiKey: 'sk-attacker', next: '/' }),
      redirect: 'manual',
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a submission naming no apiKey field at all', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ next: '/' }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Enter your LiteLLM virtual key')
  })

  it('refuses an oversized form body with the HTML form, not JSON', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'x'.repeat(9000) }),
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('reports a proxy failure that is neither an auth refusal nor a transport failure', async () => {
    internals.createClient = () => ({
      verifyKey: () => Promise.reject(new LiteLlmRequestError({ code: 'RATE_LIMIT', message: 'slow down', status: 429 })),
      listModels: () => Promise.resolve([]),
    }) as unknown as LiteLlmClient
    const port = await boot()
    const response = await signIn(port, 'sk-alice')
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('slow down')
  })

  it('reports an unexpected non-proxy failure as a generic sign-in failure', async () => {
    internals.createClient = () => ({
      verifyKey: () => Promise.reject(new Error('boom')),
      listModels: () => Promise.resolve([]),
    }) as unknown as LiteLlmClient
    const port = await boot()
    const response = await signIn(port, 'sk-alice')
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('unexpected reason')
  })
})

describe('the programmatic sign-in', () => {
  it('answers a JSON caller with the session view, never the key', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', key_alias: 'CI', models: ['gpt-4o'] } })
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-alice' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({
      principalId: expect.stringMatching(/^alice-[0-9a-f]{16}$/) as unknown,
      displayName: 'CI',
      models: ['gpt-4o'],
    })
    expect(JSON.stringify(body)).not.toContain('sk-alice')
  })

  it('answers a JSON caller refusal as JSON', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain('not valid JSON')
  })

  it('refuses a body too large to be a sign-in', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'x'.repeat(9000) }),
    })
    expect(response.status).toBe(413)
  })

  it('refuses a key the proxy rejects with a JSON body', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-wrong' }),
    })
    expect(response.status).toBe(401)
    expect((await response.json() as { error: string }).error).toContain('refused by the LiteLLM proxy')
  })

  it('refuses a key naming no user with a JSON body', async () => {
    scriptProxy({ 'sk-nameless': {} })
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-nameless' }),
    })
    expect(response.status).toBe(403)
  })

  it('refuses an empty key with a JSON body', async () => {
    scriptProxy({})
    const port = await boot()
    const response = await fetch(url(port, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: '   ' }),
    })
    expect(response.status).toBe(400)
  })

  it('closes a session from a JSON caller', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const response = await fetch(url(port, LOGOUT_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ signedOut: true })
    expect((await fetch(url(port, SESSION_PATH), { headers: { cookie } })).status).toBe(401)
  })
})

describe('the session endpoint', () => {
  it('names the signed-in user and withholds their key', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const response = await fetch(url(port, SESSION_PATH), { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('sk-alice')
  })

  it('answers 401 with no session', async () => {
    scriptProxy({})
    const port = await boot()
    expect((await fetch(url(port, SESSION_PATH))).status).toBe(401)
  })
})

describe('signing out', () => {
  it('closes the session and clears the cookie', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const out = await fetch(url(port, LOGOUT_PATH), { method: 'POST', headers: { cookie }, redirect: 'manual' })
    expect(out.status).toBe(303)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(url(port, SESSION_PATH), { headers: { cookie } })).status).toBe(401)
  })

  it('succeeds from a stale tab that has no live session', async () => {
    scriptProxy({})
    const port = await boot()
    const out = await fetch(url(port, LOGOUT_PATH), { method: 'POST', redirect: 'manual' })
    expect(out.status).toBe(303)
  })

  it('refuses a cross-site logout attempt, leaving the session live', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const out = await fetch(url(port, LOGOUT_PATH), {
      method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' }, redirect: 'manual',
    })
    expect(out.status).toBe(403)
    expect((await fetch(url(port, SESSION_PATH), { headers: { cookie } })).status).toBe(200)
  })
})

describe('the principal service the plugin provides', () => {
  it('authenticates a request carrying a live session cookie', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: ['gpt-4o'] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const principal = context!.principal.authenticate({ headers: { cookie } })
    expect(principal?.models).toEqual(['gpt-4o'])
    expect(principal?.secret).toBe('sk-alice')
  })

  it('authenticates a request carrying its cookie in a Headers instance', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const principal = context!.principal.authenticate({ headers: new Headers({ cookie }) })
    expect(principal?.secret).toBe('sk-alice')
  })

  it('answers undefined for a Headers instance carrying no cookie', async () => {
    scriptProxy({})
    await boot()
    expect(context!.principal.authenticate({ headers: new Headers() })).toBeUndefined()
  })

  it('reports whether the deployment refuses unauthenticated requests', async () => {
    scriptProxy({})
    await boot()
    expect(context!.principal.required).toBe(true)
    await context!.fiber.dispose()
    await boot({ requireLogin: false })
    expect(context!.principal.required).toBe(false)
  })

  it('forgets every session when the plugin unmounts', async () => {
    scriptProxy({ 'sk-alice': { user_id: 'alice', models: [] } })
    const port = await boot()
    const cookie = cookieOf(await signIn(port, 'sk-alice'))
    const service = context!.principal
    await context!.fiber.dispose()
    context = undefined
    expect(service.authenticate({ headers: { cookie } })).toBeUndefined()
  })
})
