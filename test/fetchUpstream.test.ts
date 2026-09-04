import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchIsbnNetHtml } from '../src/fetchUpstream';

/**
 * A stand-in for Response giving exact control over headers — in particular
 * whether `getSetCookie` exists, which selects between the two cookie-parsing
 * paths in updateCookieJar.
 */
function reply(opts: {
  status: number;
  body?: string;
  location?: string;
  setCookie?: string[];
  /** Force the raw `set-cookie` fallback by omitting getSetCookie. */
  legacyHeaders?: boolean;
}) {
  const headers: Record<string, unknown> = {
    get: (name: string) => {
      const key = name.toLowerCase();
      if (key === 'location') return opts.location ?? null;
      if (key === 'set-cookie') return opts.setCookie?.join(', ') ?? null;
      return null;
    },
  };
  if (!opts.legacyHeaders) {
    headers.getSetCookie = () => opts.setCookie ?? [];
  }
  return {
    status: opts.status,
    headers,
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const callArgs = (n: number) => fetchMock.mock.calls[n] as [string, RequestInit];
const headerOf = (n: number, name: string) =>
  (callArgs(n)[1].headers as Record<string, string>)[name];

describe('fetchIsbnNetHtml', () => {
  it('returns the body of a 200 and asks for the right ISBN', async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: '<html>ok</html>' }));

    await expect(fetchIsbnNetHtml('9789571234567')).resolves.toBe('<html>ok</html>');
    expect(callArgs(0)[0]).toContain('Pval=9789571234567');
    expect(callArgs(0)[1].redirect).toBe('manual');
  });

  it('identifies itself, as agreed with the upstream operator', async () => {
    fetchMock.mockResolvedValue(reply({ status: 200 }));
    await fetchIsbnNetHtml('9789571234567');
    expect(headerOf(0, 'User-Agent')).toBe('UniBooks-ISBNnet-Resolver/1.0');
  });

  it('percent-encodes the ISBN into the query', async () => {
    fetchMock.mockResolvedValue(reply({ status: 200 }));
    await fetchIsbnNetHtml('012345678X');
    expect(callArgs(0)[0]).toContain('Pval=012345678X');
  });

  describe('redirects', () => {
    it('follows one and returns the final body', async () => {
      fetchMock
        .mockResolvedValueOnce(reply({ status: 302, location: '/NEW_ISBNNet/results.php' }))
        .mockResolvedValueOnce(reply({ status: 200, body: 'final' }));

      await expect(fetchIsbnNetHtml('9789571234567')).resolves.toBe('final');
      expect(callArgs(1)[0]).toBe('https://isbn.ncl.edu.tw/NEW_ISBNNet/results.php');
    });

    it('resolves a relative Location against the URL it came from', async () => {
      fetchMock
        .mockResolvedValueOnce(reply({ status: 302, location: 'H30_SearchBooks.php?x=1' }))
        .mockResolvedValueOnce(reply({ status: 200, body: 'ok' }));

      await fetchIsbnNetHtml('9789571234567');
      expect(callArgs(1)[0]).toBe('https://isbn.ncl.edu.tw/NEW_ISBNNet/H30_SearchBooks.php?x=1');
    });

    it('gives up rather than looping forever', async () => {
      // Upstream has been seen to bounce between two URLs; without the hop
      // cap this would spin until the Worker's own time limit killed it.
      fetchMock.mockResolvedValue(reply({ status: 302, location: '/loop' }));

      await expect(fetchIsbnNetHtml('9789571234567')).rejects.toThrow(/maximum redirect hops/i);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('throws when a redirect carries no Location', async () => {
      fetchMock.mockResolvedValue(reply({ status: 302 }));
      await expect(fetchIsbnNetHtml('9789571234567')).rejects.toThrow(/missing Location/i);
    });
  });

  describe('session cookies', () => {
    it('carries a cookie from the redirect onto the next hop', async () => {
      // The search results are session-scoped: drop the cookie and the second
      // request comes back as an empty result rather than the book.
      fetchMock
        .mockResolvedValueOnce(reply({
          status: 302,
          location: '/results',
          setCookie: ['PHPSESSID=abc123; path=/; HttpOnly'],
        }))
        .mockResolvedValueOnce(reply({ status: 200, body: 'ok' }));

      await fetchIsbnNetHtml('9789571234567');
      expect(headerOf(0, 'Cookie')).toBeUndefined();
      expect(headerOf(1, 'Cookie')).toBe('PHPSESSID=abc123');
    });

    it('accumulates several cookies across hops', async () => {
      fetchMock
        .mockResolvedValueOnce(reply({ status: 302, location: '/a', setCookie: ['a=1; path=/'] }))
        .mockResolvedValueOnce(reply({ status: 302, location: '/b', setCookie: ['b=2; path=/'] }))
        .mockResolvedValueOnce(reply({ status: 200, body: 'ok' }));

      await fetchIsbnNetHtml('9789571234567');
      expect(headerOf(2, 'Cookie')).toBe('a=1; b=2');
    });

    it('lets a later value replace an earlier one of the same name', async () => {
      fetchMock
        .mockResolvedValueOnce(reply({ status: 302, location: '/a', setCookie: ['s=old'] }))
        .mockResolvedValueOnce(reply({ status: 302, location: '/b', setCookie: ['s=new'] }))
        .mockResolvedValueOnce(reply({ status: 200, body: 'ok' }));

      await fetchIsbnNetHtml('9789571234567');
      expect(headerOf(2, 'Cookie')).toBe('s=new');
    });

    it('splits a comma-joined set-cookie header when getSetCookie is missing', async () => {
      // The fallback path: one header carrying two cookies, where the split
      // must not be fooled by the comma inside a date such as
      // "expires=Wed, 09 Jun 2027".
      fetchMock
        .mockResolvedValueOnce(reply({
          status: 302,
          location: '/results',
          legacyHeaders: true,
          setCookie: ['PHPSESSID=abc; expires=Wed, 09 Jun 2027 10:18:14 GMT; path=/', 'lang=zh-TW; path=/'],
        }))
        .mockResolvedValueOnce(reply({ status: 200, body: 'ok' }));

      await fetchIsbnNetHtml('9789571234567');
      expect(headerOf(1, 'Cookie')).toBe('PHPSESSID=abc; lang=zh-TW');
    });
  });

  it('throws on an unexpected status instead of returning an error page as HTML', async () => {
    // Returning the body here would hand the parser a maintenance page and
    // let it answer 404 "no such book" for what is really an outage.
    fetchMock.mockResolvedValue(reply({ status: 500, body: '<html>error</html>' }));
    await expect(fetchIsbnNetHtml('9789571234567')).rejects.toThrow(/unexpected HTTP status: 500/);
  });
});
