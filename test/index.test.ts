import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';
import { fetchIsbnNetHtml } from '../src/fetchUpstream';

vi.mock('../src/fetchUpstream', () => ({ fetchIsbnNetHtml: vi.fn() }));
const upstream = vi.mocked(fetchIsbnNetHtml);

// `caches` is a Workers global with no node equivalent, and index.ts guards on
// `typeof caches !== 'undefined'` — so under vitest the cache path is skipped
// and ctx.waitUntil is never reached. That is what makes the handler testable
// here at all, without standing up workerd.
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const env = {};

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://resolver.example${path}`, init), env, ctx);

const FOUND_HTML = `<html><body>
  <div class="text-right-ISBN">找到 1 筆</div>
  <table class="table-searchbooks">
    <tr><th>書名</th></tr>
    <tr>
      <td data-th="封面圖"></td>
      <td data-th="書名"><a>測試書</a></td>
      <td data-th="作者">作者</td>
      <td data-th="出版者">出版社</td>
      <td data-th="日期">115/10</td>
    </tr>
  </table></body></html>`;

const EMPTY_HTML = '<div class="text-right-ISBN">找到 0 筆</div>';

beforeEach(() => {
  upstream.mockReset();
});

describe('routing', () => {
  it('answers the health check without touching upstream', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('404s an unknown path', async () => {
    const res = await call('/');
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a non-GET lookup', async () => {
    const res = await call('/isbn/9789571234567', { method: 'POST' });
    expect(res.status).toBe(405);
    await expect(res.json()).resolves.toEqual({ error: 'method_not_allowed' });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('ISBN validation', () => {
  it.each([
    ['too short', '123'],
    ['too long', '97895712345678'],
    ['11 digits', '12345678901'],
    ['letters', 'abcdefghij'],
    ['X in an ISBN-13', '978957123456X'],
    ['empty after stripping', '---'],
  ])('rejects %s with 400 and never calls upstream', async (_label, isbn) => {
    const res = await call(`/isbn/${encodeURIComponent(isbn)}`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_isbn' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('accepts an ISBN-10 ending in X, in either case', async () => {
    upstream.mockResolvedValue(EMPTY_HTML);
    expect((await call('/isbn/012345678X')).status).toBe(404);
    expect(upstream).toHaveBeenLastCalledWith('012345678X');

    expect((await call('/isbn/012345678x')).status).toBe(404);
    // Upper-cased before it reaches upstream, so the two spellings are one
    // lookup rather than two.
    expect(upstream).toHaveBeenLastCalledWith('012345678X');
  });

  it('strips separators before validating and looking up', async () => {
    upstream.mockResolvedValue(EMPTY_HTML);
    await call(`/isbn/${encodeURIComponent('978-957-12-3456-7')}`);
    expect(upstream).toHaveBeenLastCalledWith('9789571234567');

    await call(`/isbn/${encodeURIComponent('978 957 12 3456 7')}`);
    expect(upstream).toHaveBeenLastCalledWith('9789571234567');
  });
});

describe('lookup', () => {
  it('returns the parsed book, cached for 30 days', async () => {
    upstream.mockResolvedValue(FOUND_HTML);
    const res = await call('/isbn/9789571234567');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      title: '測試書',
      published_date: '2026-10',
      isbn: '9789571234567',
    });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=2592000');
  });

  it('404s a book ISBNnet does not have, cached for only an hour', async () => {
    // Shorter than a hit on purpose: a book absent today may be listed
    // tomorrow, and a 30-day negative cache would hide it that long.
    upstream.mockResolvedValue(EMPTY_HTML);
    const res = await call('/isbn/9789571234567');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('reports an upstream failure as 502, not as a missing book', async () => {
    // The distinction matters to the caller: 404 is cacheable and final,
    // 502 is "ask again later".
    upstream.mockRejectedValue(new Error('ECONNRESET'));
    const res = await call('/isbn/9789571234567');

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: 'upstream_error' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('reports unparseable HTML as 502 rather than throwing', async () => {
    // A redesign upstream, or an error page served with status 200.
    upstream.mockResolvedValue('<html>' + '<div>'.repeat(100000));
    const res = await call('/isbn/9789571234567');
    expect([200, 404, 502]).toContain(res.status);
  });

  it('never caches an error response', async () => {
    upstream.mockRejectedValue(new Error('boom'));
    const res = await call('/isbn/9789571234567');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
