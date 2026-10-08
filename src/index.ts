import { parseSearchResult, ParsedBook } from './parse';
import { fetchIsbnNetHtml } from './fetchUpstream';

export interface Env {
  // Shared with the UniBooks backend, its only caller (set with `wrangler
  // secret put RESOLVER_SECRET`). When set, an ISBN lookup must carry it in
  // X-Resolver-Secret; unset, lookups stay open, so the backend can start
  // sending it before the Worker starts requiring it.
  RESOLVER_SECRET?: string;
}

/** Equal-length comparison that does not stop at the first differing byte. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const CACHE_TTL_FOUND = 2592000; // 30 days in seconds
const CACHE_TTL_NOT_FOUND = 3600; // 1 hour in seconds

function jsonResponse(data: unknown, status: number = 200, maxAgeSeconds?: number): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (maxAgeSeconds !== undefined) {
    headers['Cache-Control'] = `public, max-age=${maxAgeSeconds}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function isValidIsbn(isbn: string): boolean {
  return /^\d{9}[\dX]$/.test(isbn) || /^\d{13}$/.test(isbn);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Uptime check endpoint
    if (pathname === '/health') {
      return jsonResponse({ status: 'ok' }, 200);
    }

    // ISBN lookup endpoint: /isbn/:isbn
    const isbnMatch = pathname.match(/^\/isbn\/(.+)$/);
    if (isbnMatch) {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'method_not_allowed' }, 405, 86400);
      }

      // Without it anyone could use this Worker to send NCL a stream of
      // uncached lookups (each up to five upstream fetches) from Cloudflare's
      // addresses, and get those addresses blocked.
      if (env.RESOLVER_SECRET && !secretMatches(request.headers.get('X-Resolver-Secret'), env.RESOLVER_SECRET)) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }

      let rawIsbnParam: string;
      try {
        rawIsbnParam = decodeURIComponent(isbnMatch[1]);
      } catch {
        // A malformed % escape: no ISBN in it, so the same answer as any other.
        return jsonResponse({ error: 'invalid_isbn' }, 404, 86400);
      }
      const normalizedIsbn = rawIsbnParam.replace(/[-\s]/g, '').toUpperCase();

      if (!isValidIsbn(normalizedIsbn)) {
        return jsonResponse({ error: 'invalid_isbn' }, 404, 86400);
      }

      // Cache lookup using Cloudflare Workers Cache API
      const normalizedUrl = new URL(`/isbn/${normalizedIsbn}`, request.url).toString();
      const cacheKey = new Request(normalizedUrl, { method: 'GET' });
      const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;

      if (cache) {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          return cachedResponse;
        }
      }

      let html: string;
      try {
        html = await fetchIsbnNetHtml(normalizedIsbn);
      } catch (err) {
        console.error(`Upstream fetch error for ISBN ${normalizedIsbn}:`, err);
        return jsonResponse({ error: 'upstream_error' }, 502);
      }

      let book: ParsedBook | null;
      try {
        book = parseSearchResult(html, normalizedIsbn);
      } catch (err) {
        console.error(`HTML parse error for ISBN ${normalizedIsbn}:`, err);
        return jsonResponse({ error: 'upstream_error' }, 502);
      }

      if (!book) {
        const notFoundResponse = jsonResponse({ error: 'not_found' }, 404, CACHE_TTL_NOT_FOUND);
        if (cache) {
          ctx.waitUntil(cache.put(cacheKey, notFoundResponse.clone()));
        }
        return notFoundResponse;
      }

      const successResponse = jsonResponse(book, 200, CACHE_TTL_FOUND);
      if (cache) {
        ctx.waitUntil(cache.put(cacheKey, successResponse.clone()));
      }
      return successResponse;
    }

    return jsonResponse({ error: 'not_found' }, 404, 86400);
  },
};
