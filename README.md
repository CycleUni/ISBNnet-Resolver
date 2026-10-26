# ISBNnet Resolver

A standalone Cloudflare Worker microservice for the [UniBooks](https://github.com/CycleUni) project (used-textbook marketplace). Its sole responsibility is looking up book metadata from Taiwan's National Central Library ISBN-net ([https://isbn.ncl.edu.tw/NEW_ISBNNet/](https://isbn.ncl.edu.tw/NEW_ISBNNet/)) by scraping search results for exact ISBN queries and returning clean JSON.

> **Disclaimer**: This microservice is an unofficial, best-effort scraper of a public government website and may break if upstream markup or redirect flows change. The HTML parsing logic is strictly isolated in [`src/parse.ts`](src/parse.ts) to facilitate quick patching and test maintenance.

---

## API Endpoints

### 1. Health Check
`GET /health`

**Response (`200 OK`)**:
```json
{
  "status": "ok"
}
```

---

### 2. ISBN Lookup
`GET /isbn/:isbn`

Exact ISBN-10 or ISBN-13 lookup. Hyphens (`-`) and whitespace in `:isbn` are automatically stripped, and check digits (`X`) are uppercased.

When the Worker has an `ISBNNET_RESOLVER_SECRET`, the request must send the same value in `X-Resolver-Secret`, or it gets `401 {"error": "unauthorized"}`. The UniBooks backend sends its own `ISBNNET_RESOLVER_SECRET`, the same variable name on both sides. `/health` stays open.

#### Success Response (`200 OK`)
Kept in Workers Cache for 30 days (`Cache-Control: public, max-age=2592000`).

```json
{
  "title": "公職考試試題大補帖. 2027: 電路學與電子學(含電路學、電子學、電子學概要、電子學與電路學)(111~115年試題)(申論題型)",
  "authors": "張鼎, 曾誠, 劉強編著",
  "publisher": "大碩教育",
  "published_date": "2026-10",
  "cover_url": "https://pdsapp.ncl.edu.tw/api/v1/viewer/public/cover/9786264048668",
  "isbn": "9786264048668"
}
```

#### Not Found Response (`404 Not Found`)
Returned when the search confirmed 0 matching records. Cached for 1 hour (`Cache-Control: public, max-age=3600`).

```json
{
  "error": "not_found"
}
```

#### Invalid ISBN Response (`404 Not Found`)
Returned when the provided ISBN fails format validation (neither a valid 10-character nor 13-digit pattern). Cached for 24 hours (`Cache-Control: public, max-age=86400`) to prevent abuse at the edge.

```json
{
  "error": "invalid_isbn"
}
```

#### Upstream Error Response (`502 Bad Gateway`)
Returned when upstream network requests, redirect chains, or parsing encounter unrecoverable errors or timeouts. Never cached.

```json
{
  "error": "upstream_error"
}
```

---

### 3. RPC (service bindings)
`lookup(isbn: string): Promise<IsbnLookup>`

The default export is a `WorkerEntrypoint`, so a Worker with a service binding to `isbnnet-resolver` (the UniBooks backend binds it as `ISBNNET`) calls `env.ISBNNET.lookup(isbn)` directly instead of building an HTTP request. It normalizes and validates the ISBN like `/isbn/:isbn` and shares its cache (see [Caching](#caching-workers-cache)), and returns one of:

```ts
{ status: 'found', book: { title, authors, publisher, published_date, cover_url, isbn } }
{ status: 'not_found' }
{ status: 'invalid_isbn' }
{ status: 'upstream_error' }
```

It needs no `X-Resolver-Secret`: only a service binding in the same Cloudflare account can reach an RPC method.

---

## Caching (Workers Cache)

Lookups are cached by [Workers Cache](https://developers.cloudflare.com/workers/cache/), configured in [`wrangler.toml`](wrangler.toml). It only stores `fetch()` calls, never RPC, so both `GET /isbn/:isbn` and `lookup()` normalize the ISBN and then loop back through `ctx.exports` to `GET /isbn/<normalized ISBN>` on the `CachedLookup` entrypoint — the only one with caching on. One ISBN is therefore one cache entry whichever way it was asked:

- A hit is answered without running `CachedLookup` at all, so ISBN-net is not contacted; the Cache-Control TTLs above decide how long. `upstream_error` (`no-store`) is never kept.
- Concurrent misses for the same ISBN in a data center are collapsed into one upstream lookup, and a lower/upper cache tier is shared across locations.
- When a stale entry's refresh fails upstream, Cloudflare keeps serving the stale answer.
- The default entrypoint (secret check, `/health`, the RPC method) is uncached and runs on every call.
- The Worker version is part of the cache key, so each deploy starts from an empty cache. Purge with `ctx.cache.purge()` if a cached answer must go sooner.

`wrangler dev` does not emulate Workers Cache; check `Cf-Cache-Status` on a deployed lookup instead. With caching on, each loopback call to `CachedLookup` is billed as a request, where a worker-to-worker call is otherwise free.

---

## Architecture & Code Structure

- **[`src/parse.ts`](src/parse.ts)**: Pure Cheerio-based parser (`parseSearchResult(html, requestedIsbn)`) that extracts metadata from raw HTML. Contains zero network dependencies for easy unit testing.
- **[`src/fetchUpstream.ts`](src/fetchUpstream.ts)**: Multi-hop redirect fetcher with session cookie preservation and timeouts (~8s via `AbortController`).
- **[`src/index.ts`](src/index.ts)**: Worker entrypoint (`WorkerEntrypoint`: the HTTP routes and the `lookup` RPC method), the `CachedLookup` entrypoint Workers Cache sits in front of, and ISBN normalization & validation.
- **[`test/parse.test.ts`](test/parse.test.ts)**: Vitest unit tests verifying parser functionality against real HTML snapshots in `test/fixtures/`.

---

## Development & Testing

### Install Dependencies
```bash
npm install
```

### Run Unit Tests
```bash
npm test
```

### Run Type Check
```bash
npm run typecheck
```

### Environment Variables
The keys are listed in [`.dev.vars.example`](.dev.vars.example). For local dev, copy it to `.dev.vars` (gitignored), which `wrangler dev` loads. In production, set them with `wrangler secret put`.

| Key | Required | Purpose |
|---|---|---|
| `ISBNNET_RESOLVER_SECRET` | No | When set, `/isbn/` lookups must send the same value in `X-Resolver-Secret`. Same name and value as UniBooks-BE's. |

### Run Locally with Wrangler
```bash
npx wrangler dev
```

### Deploy to Cloudflare Workers
```bash
npx wrangler deploy
```

`wrangler.toml` turns off the `workers.dev` and preview URLs, so the deployed Worker has no public address: only a service binding in the same account (the UniBooks backend's `ISBNNET`) reaches it. To call `/isbn/` over HTTPS, give it a route or turn `workers_dev` back on, and set `ISBNNET_RESOLVER_SECRET` first.

To lock lookups to the backend, set `ISBNNET_RESOLVER_SECRET` on the backend and deploy it first, then set the same value here:
```bash
npx wrangler secret put ISBNNET_RESOLVER_SECRET
```
