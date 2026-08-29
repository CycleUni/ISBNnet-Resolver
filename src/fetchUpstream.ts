const USER_AGENT = 'UniBooks-ISBNnet-Resolver/1.0';
const BASE_SEARCH_URL = 'https://isbn.ncl.edu.tw/NEW_ISBNNet/H30_SearchBooks.php';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REDIRECT_HOPS = 5;

/**
 * Updates a cookie jar with cookies from Set-Cookie headers on a Response.
 */
function updateCookieJar(response: Response, cookieJar: Map<string, string>): void {
  if (typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
    const cookies = (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
    for (const cookie of cookies) {
      const pair = cookie.split(';')[0].trim();
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        if (name) {
          cookieJar.set(name, value);
        }
      }
    }
  } else {
    const rawHeader = response.headers.get('set-cookie');
    if (rawHeader) {
      const parts = rawHeader.split(/,(?=\s*[a-zA-Z0-9_%-]+=[^;]+)/);
      for (const part of parts) {
        const pair = part.split(';')[0].trim();
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const name = pair.slice(0, eqIdx).trim();
          const value = pair.slice(eqIdx + 1).trim();
          if (name) {
            cookieJar.set(name, value);
          }
        }
      }
    }
  }
}

/**
 * Formats cookies from the jar into a Cookie header string.
 */
function formatCookieHeader(cookieJar: Map<string, string>): string {
  return Array.from(cookieJar.entries())
    .map(([name, val]) => `${name}=${val}`)
    .join('; ');
}

/**
 * Fetches the ISBN-net results page HTML for a given ISBN, manually following
 * redirects and preserving session cookies across hops.
 */
export async function fetchIsbnNetHtml(isbn: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  let currentUrl = `${BASE_SEARCH_URL}?Pact=Search&Pval=${encodeURIComponent(isbn)}`;
  const cookieJar = new Map<string, string>();

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      };

      const cookieStr = formatCookieHeader(cookieJar);
      if (cookieStr) {
        headers['Cookie'] = cookieStr;
      }

      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });

      updateCookieJar(response, cookieJar);

      // Handle redirects (301, 302, 303, 307, 308)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect response (${response.status}) missing Location header`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (response.status === 200) {
        return await response.text();
      }

      throw new Error(`Upstream returned unexpected HTTP status: ${response.status}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Exceeded maximum redirect hops (${MAX_REDIRECT_HOPS})`);
}
