/**
 * Request and response helpers shared by the sign-in routes: body reading,
 * return-path validation, and the two response forms a browser form post and
 * a programmatic client each expect.
 * @module @deepseek-ai/dsh-litellm-auth/src/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Refuse a body larger than any legitimate sign-in post, before buffering it. */
const MAX_BODY_BYTES = 8 * 1024

/** How the caller asked, and therefore how it must be answered. */
export type RequestStyle = 'form' | 'json'

/**
 * Whether this request is a browser form post or a programmatic JSON call.
 *
 * The two need different success responses — a redirect the browser follows,
 * a document a client parses — and the request's own `Content-Type` is the
 * only honest signal of which one is asking.
 * @param request - the inbound request.
 * @returns the style to answer in.
 */
export function requestStyle(request: IncomingMessage): RequestStyle {
  const contentType = request.headers['content-type'] ?? ''
  return contentType.includes('application/json') ? 'json' : 'form'
}

/** A body was refused before parsing; `status` is what the route must answer. */
export class BodyRejected extends Error {
  /**
   * @param status - the HTTP status to answer.
   * @param message - the refusal to state.
   */
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'BodyRejected'
  }
}

/**
 * Read the submitted API key out of either body form.
 *
 * The whole body is buffered because it is bounded to {@link MAX_BODY_BYTES}
 * first: a sign-in post carries one key and one return path, so anything
 * larger is not a sign-in and is refused before it is read rather than
 * streamed and parsed.
 * @param request - the inbound request.
 * @param style - the body form to parse.
 * @returns the submitted key and return path, each absent when the body omitted it.
 * @throws BodyRejected when the body is oversized or unparsable.
 */
export async function readCredentials(
  request: IncomingMessage,
  style: RequestStyle,
): Promise<{ apiKey?: string; next?: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new BodyRejected(413, 'sign-in request body is too large')
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (style === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new BodyRejected(400, 'sign-in request body is not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BodyRejected(400, 'sign-in request body must be a JSON object')
    }
    const record = parsed as Record<string, unknown>
    return {
      ...typeof record.apiKey === 'string' ? { apiKey: record.apiKey } : {},
      ...typeof record.next === 'string' ? { next: record.next } : {},
    }
  }
  const fields = new URLSearchParams(body)
  const apiKey = fields.get('apiKey') ?? undefined
  const next = fields.get('next') ?? undefined
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...next === undefined ? {} : { next },
  }
}

/**
 * Reduce a requested return path to one this server will redirect to.
 *
 * Only a rooted same-origin path survives: anything starting with `//` or
 * carrying a scheme is an open redirect, which turns this sign-in page into a
 * credible launch point for a phishing link. Everything refused becomes `/`,
 * silently, because a user who followed a tampered link should land on the
 * application rather than read about it.
 * @param requested - the `next` value from the query string or body.
 * @returns a safe absolute path, defaulting to `/`.
 */
export function safeReturnPath(requested: string | undefined): string {
  if (requested === undefined || !requested.startsWith('/') || requested.startsWith('//')) return '/'
  // A backslash is a path separator to some browsers' URL parsers but not to
  // WHATWG's, so `/\evil.example` would resolve off-origin in exactly the
  // clients that matter here.
  if (requested.includes('\\')) return '/'
  return requested
}

/** Answer one JSON document with no-store caching, the only caching a sign-in surface may use. */
export function writeJson(response: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...setCookie === undefined ? {} : { 'set-cookie': setCookie },
  })
  response.end(JSON.stringify(body))
}

/** Answer one HTML document with no-store caching. */
export function writeHtml(response: ServerResponse, status: number, html: string, setCookie?: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...setCookie === undefined ? {} : { 'set-cookie': setCookie },
  })
  response.end(html)
}

/** Answer one redirect the browser follows after a sign-in or sign-out. */
export function writeRedirect(response: ServerResponse, location: string, setCookie?: string): void {
  response.writeHead(303, {
    'location': location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...setCookie === undefined ? {} : { 'set-cookie': setCookie },
  })
  response.end()
}
