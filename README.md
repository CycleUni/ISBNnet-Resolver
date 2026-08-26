# ISBNnet Resolver

A standalone Cloudflare Worker microservice for the [CycleUni](https://github.com/CycleUni) project (used-textbook marketplace). Its sole responsibility is looking up book metadata from Taiwan's National Central Library ISBN-net ([https://isbn.ncl.edu.tw/NEW_ISBNNet/](https://isbn.ncl.edu.tw/NEW_ISBNNet/)) by scraping search results for exact ISBN queries and returning clean JSON.

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

#### Success Response (`200 OK`)
Cached in Cloudflare Workers Cache API for 30 days (`Cache-Control: public, max-age=2592000`).

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

#### Invalid ISBN Response (`400 Bad Request`)
Returned when the provided ISBN fails format validation (neither a valid 10-character nor 13-digit pattern).

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

## Architecture & Code Structure

- **[`src/parse.ts`](src/parse.ts)**: Pure Cheerio-based parser (`parseSearchResult(html, requestedIsbn)`) that extracts metadata from raw HTML. Contains zero network dependencies for easy unit testing.
- **[`src/fetchUpstream.ts`](src/fetchUpstream.ts)**: Multi-hop redirect fetcher with session cookie preservation and timeouts (~8s via `AbortController`).
- **[`src/index.ts`](src/index.ts)**: Worker entrypoint handling routing, ISBN normalization & validation, and edge caching with `caches.default`.
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

### Run Locally with Wrangler
```bash
npx wrangler dev
```

### Deploy to Cloudflare Workers
```bash
npx wrangler deploy
```
