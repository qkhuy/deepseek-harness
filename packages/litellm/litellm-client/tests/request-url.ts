/**
 * The URL a scripted fetch double was called with. `fetch` accepts a string, a
 * `URL`, or a `Request`, and only the third has no useful default
 * stringification, so the three are separated here once instead of at each
 * double.
 * @param input - the first argument the double received.
 * @returns the absolute request URL.
 */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}
