import { describe, expect, it } from 'vitest'
import { classifyLiteLlmFailure, liteLlmErrorMessage, retryAfterMs } from '../src/index.ts'

describe('liteLlmErrorMessage', () => {
  it('reads every nesting LiteLLM uses for one message', () => {
    expect(liteLlmErrorMessage({ error: { message: 'a' } })).toBe('a')
    expect(liteLlmErrorMessage({ detail: { error: { message: 'b' } } })).toBe('b')
    expect(liteLlmErrorMessage({ detail: 'c' })).toBe('c')
    expect(liteLlmErrorMessage('d')).toBe('d')
  })

  it('answers undefined for a body carrying no message', () => {
    expect(liteLlmErrorMessage('')).toBeUndefined()
    expect(liteLlmErrorMessage({})).toBeUndefined()
    expect(liteLlmErrorMessage({ error: 'not-an-object' })).toBeUndefined()
    expect(liteLlmErrorMessage(null)).toBeUndefined()
    expect(liteLlmErrorMessage([1, 2])).toBeUndefined()
  })
})

describe('retryAfterMs', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')

  it('reads delay-seconds', () => {
    expect(retryAfterMs('30', now)).toBe(30_000)
    expect(retryAfterMs(' 1.5 ', now)).toBe(1500)
  })

  it('reads an HTTP-date as the remaining delay', () => {
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000)
  })

  it('yields no delay for absent, unusable, or already-elapsed values', () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined()
    expect(retryAfterMs('   ', now)).toBeUndefined()
    expect(retryAfterMs('soon', now)).toBeUndefined()
    expect(retryAfterMs('0', now)).toBeUndefined()
    expect(retryAfterMs('-5', now)).toBeUndefined()
    expect(retryAfterMs('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBeUndefined()
  })
})

describe('classifyLiteLlmFailure', () => {
  it('classifies a refused key as AUTH', () => {
    expect(classifyLiteLlmFailure(401, { error: { message: 'Invalid proxy server token' } }).code).toBe('AUTH')
    expect(classifyLiteLlmFailure(403, {}).code).toBe('AUTH')
  })

  it('classifies an exceeded budget as QUOTA even at HTTP 400', () => {
    const failure = classifyLiteLlmFailure(400, {
      error: { message: 'ExceededBudget: Crossed spend within budget has been exceeded for key' },
    })
    expect(failure.code).toBe('QUOTA')
    expect(failure.status).toBe(400)
  })

  it('classifies an exhausted allowance as RATE_LIMIT at HTTP 400', () => {
    expect(classifyLiteLlmFailure(400, { detail: 'Max parallel request limit reached' }).code).toBe('RATE_LIMIT')
    expect(classifyLiteLlmFailure(400, { detail: 'Key rpm limit reached' }).code).toBe('RATE_LIMIT')
  })

  it('falls back to the status for everything the message does not name', () => {
    expect(classifyLiteLlmFailure(402, {}).code).toBe('QUOTA')
    expect(classifyLiteLlmFailure(429, {}).code).toBe('RATE_LIMIT')
    expect(classifyLiteLlmFailure(404, {}).code).toBe('UNKNOWN_MODEL')
    expect(classifyLiteLlmFailure(400, {}).code).toBe('BAD_REQUEST')
    expect(classifyLiteLlmFailure(500, {}).code).toBe('SERVER')
    expect(classifyLiteLlmFailure(302, {}).code).toBe('SERVER')
  })

  it('carries the proxy message, status, and retry delay', () => {
    const failure = classifyLiteLlmFailure(429, { error: { message: 'slow down' } }, '2')
    expect(failure).toEqual({ code: 'RATE_LIMIT', message: 'slow down', status: 429, retryAfterMs: 2000 })
  })

  it('states the status when the proxy sent no message', () => {
    expect(classifyLiteLlmFailure(503, {}).message).toBe('LiteLLM proxy answered HTTP 503')
  })
})
