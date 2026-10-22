import { WorkerEntrypoint } from 'cloudflare:workers';
import { parseSearchResult, ParsedBook } from './parse';
import { fetchIsbnNetHtml } from './fetchUpstream';

export interface Env {
  // Shared with the UniBooks backend, its only caller, under the same name
  // there (set here with `wrangler secret put ISBNNET_RESOLVER_SECRET`).
  // When set, an HTTP lookup must carry it in X-Resolver-Secret; unset,
  // lookups stay open, so the backend can start sending it first. The RPC
  // lookup() needs none: only a service binding in this account can reach it.
  ISBNNET_RESOLVER_SECRET?: string;
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

/** What one lookup came to; the HTTP route maps each to a status code. */
export type IsbnLookup =
  | { status: 'found'; book: ParsedBook }
  | { status: 'not_found' }
  | { status: 'invalid_isbn' }
  | { status: 'upstream_error' };

/** The response the HTTP route sends, and the form a lookup is cached in. */
function lookupResponse(result: IsbnLookup): Response {
  switch (result.status) {
    case 'found':
      return jsonResponse(result.book, 200, CACHE_TTL_FOUND);
    case 'not_found':
      return jsonResponse({ error: 'not_found' }, 404, CACHE_TTL_NOT_FOUND);
    case 'invalid_isbn':
      return jsonResponse({ error: 'invalid_isbn' }, 404, 86400);
    case 'upstream_error':
      return jsonResponse({ error: 'upstream_error' }, 502);
  }
}

async function cachedLookup(cached: Response): Promise<IsbnLookup> {
  if (cached.status === 200) return { status: 'found', book: (await cached.json()) as ParsedBook };
  return { status: 'not_found' };
}

/** Strips separators and upper-cases the check digit; null when no valid ISBN is left. */
function normalizeIsbn(raw: string): string | null {
  const isbn = raw.replace(/[-\s]/g, '').toUpperCase();
  return isValidIsbn(isbn) ? isbn : null;
}

/**
 * One lookup of a normalized ISBN, through the edge cache. Both the HTTP route
 * and the RPC method come here, so they share one cache: keyed by `origin`,
 * the host the HTTP route was called on, or a fixed one for RPC.
 */
async function resolveIsbn(isbn: string, origin: string, ctx: ExecutionContext): Promise<IsbnLookup> {
  // Cache lookup using Cloudflare Workers Cache API
  const cacheKey = new Request(new URL(`/isbn/${isbn}`, origin).toString(), { method: 'GET' });
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;

  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedLookup(cachedResponse);
    }
  }

  let html: string;
  try {
    html = await fetchIsbnNetHtml(isbn);
  } catch (err) {
    console.error(`Upstream fetch error for ISBN ${isbn}:`, err);
    return { status: 'upstream_error' };
  }

  let book: ParsedBook | null;
  try {
    book = parseSearchResult(html, isbn);
  } catch (err) {
    console.error(`HTML parse error for ISBN ${isbn}:`, err);
    return { status: 'upstream_error' };
  }

  const result: IsbnLookup = book ? { status: 'found', book } : { status: 'not_found' };
  if (cache) {
    ctx.waitUntil(cache.put(cacheKey, lookupResponse(result)));
  }
  return result;
}

/** The cache host for RPC lookups, which come with no request URL of their own. */
const RPC_ORIGIN = 'https://isbnnet-resolver';

export default class IsbnnetResolver extends WorkerEntrypoint<Env> {
  /**
   * RPC for a service binding (the UniBooks backend): `env.ISBNNET.lookup(isbn)`.
   * Takes the ISBN as the HTTP route does, separators and all.
   */
  async lookup(isbn: string): Promise<IsbnLookup> {
    const normalizedIsbn = normalizeIsbn(String(isbn));
    if (!normalizedIsbn) return { status: 'invalid_isbn' };
    return resolveIsbn(normalizedIsbn, RPC_ORIGIN, this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
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
      const secret = this.env.ISBNNET_RESOLVER_SECRET;
      if (secret && !secretMatches(request.headers.get('X-Resolver-Secret'), secret)) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }

      let rawIsbnParam: string;
      try {
        rawIsbnParam = decodeURIComponent(isbnMatch[1]);
      } catch {
        // A malformed % escape: no ISBN in it, so the same answer as any other.
        return lookupResponse({ status: 'invalid_isbn' });
      }
      const normalizedIsbn = normalizeIsbn(rawIsbnParam);
      if (!normalizedIsbn) {
        return lookupResponse({ status: 'invalid_isbn' });
      }

      return lookupResponse(await resolveIsbn(normalizedIsbn, request.url, this.ctx));
    }

    return jsonResponse({ error: 'not_found' }, 404, 86400);
  }
}
