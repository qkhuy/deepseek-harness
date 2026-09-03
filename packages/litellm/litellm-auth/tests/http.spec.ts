/** Unit coverage for the sign-in request/response helpers, isolated from the live server. */

import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BodyRejected, readCredentials, requestStyle, writeHtml, writeJson, writeRedirect } from '../src/http.ts'

function fakeRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { headers })
  return request
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; headers?: Record<string, string>; body?: string } } {
  const state: { status?: number; headers?: Record<string, string>; body?: string } = {}
  const response = Object.assign(new EventEmitter(), {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      if (headers !== undefined) state.headers = headers
      return this
    },
    end(value?: string) {
      if (value !== undefined) state.body = value
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

describe('requestStyle', () => {
  it('reads json for an application/json content type', () => {
    expect(requestStyle(fakeRequest('', { 'content-type': 'application/json' }))).toBe('json')
  })

  it('defaults to form for every other or absent content type', () => {
    expect(requestStyle(fakeRequest('', { 'content-type': 'application/x-www-form-urlencoded' }))).toBe('form')
    expect(requestStyle(fakeRequest('', {}))).toBe('form')
  })
})

describe('readCredentials', () => {
  it('reads both fields from a JSON body', async () => {
    const body = JSON.stringify({ apiKey: 'sk-x', next: '/w/1' })
    expect(await readCredentials(fakeRequest(body), 'json')).toEqual({ apiKey: 'sk-x', next: '/w/1' })
  })

  it('reads a JSON body naming only one field', async () => {
    expect(await readCredentials(fakeRequest(JSON.stringify({ apiKey: 'sk-x' })), 'json')).toEqual({ apiKey: 'sk-x' })
    expect(await readCredentials(fakeRequest(JSON.stringify({ next: '/w/1' })), 'json')).toEqual({ next: '/w/1' })
  })

  it('refuses a JSON body that is not an object', async () => {
    await expect(readCredentials(fakeRequest('[1,2]'), 'json')).rejects.toMatchObject({ status: 400 })
    await expect(readCredentials(fakeRequest('null'), 'json')).rejects.toMatchObject({ status: 400 })
  })

  it('refuses a body that is not valid JSON', async () => {
    await expect(readCredentials(fakeRequest('{not json'), 'json')).rejects.toBeInstanceOf(BodyRejected)
  })

  it('reads both fields from a form body', async () => {
    expect(await readCredentials(fakeRequest('apiKey=sk-x&next=%2Fw%2F1'), 'form')).toEqual({
      apiKey: 'sk-x', next: '/w/1',
    })
  })

  it('reads a form body naming only one field', async () => {
    expect(await readCredentials(fakeRequest('apiKey=sk-x'), 'form')).toEqual({ apiKey: 'sk-x' })
    expect(await readCredentials(fakeRequest('next=%2Fw%2F1'), 'form')).toEqual({ next: '/w/1' })
  })

  it('reads an empty form body as naming neither field', async () => {
    expect(await readCredentials(fakeRequest(''), 'form')).toEqual({})
  })

  it('refuses a body larger than any legitimate sign-in post', async () => {
    await expect(readCredentials(fakeRequest('x'.repeat(9000)), 'form')).rejects.toMatchObject({ status: 413 })
  })
})

describe('writeJson', () => {
  it('answers with no-store caching and no cookie by default', () => {
    const { response, state } = fakeResponse()
    writeJson(response, 200, { ok: true })
    expect(state.status).toBe(200)
    expect(state.headers?.['cache-control']).toBe('no-store')
    expect(state.headers?.['set-cookie']).toBeUndefined()
    expect(state.body).toBe('{"ok":true}')
  })

  it('carries a Set-Cookie when one is given', () => {
    const { response, state } = fakeResponse()
    writeJson(response, 200, {}, 'session=abc')
    expect(state.headers?.['set-cookie']).toBe('session=abc')
  })
})

describe('writeHtml', () => {
  it('answers with no-store caching and no cookie by default', () => {
    const { response, state } = fakeResponse()
    writeHtml(response, 200, '<p>hi</p>')
    expect(state.headers?.['set-cookie']).toBeUndefined()
    expect(state.body).toBe('<p>hi</p>')
  })

  it('carries a Set-Cookie when one is given', () => {
    const { response, state } = fakeResponse()
    writeHtml(response, 200, '<p>hi</p>', 'session=abc')
    expect(state.headers?.['set-cookie']).toBe('session=abc')
  })
})

describe('writeRedirect', () => {
  it('redirects with no cookie by default', () => {
    const { response, state } = fakeResponse()
    writeRedirect(response, '/w/1')
    expect(state.status).toBe(303)
    expect(state.headers?.location).toBe('/w/1')
    expect(state.headers?.['set-cookie']).toBeUndefined()
  })

  it('carries a Set-Cookie when one is given', () => {
    const { response, state } = fakeResponse()
    writeRedirect(response, '/w/1', 'session=abc')
    expect(state.headers?.['set-cookie']).toBe('session=abc')
  })
})
