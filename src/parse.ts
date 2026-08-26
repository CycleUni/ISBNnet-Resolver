import * as cheerio from 'cheerio';

export interface ParsedBook {
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
  isbn: string;
}

/**
 * Pure function to parse the HTML returned by ISBNnet results page.
 * Returns ParsedBook if a result was found, or null if no results match.
 */
export function parseSearchResult(html: string, requestedIsbn: string): ParsedBook | null {
  const $ = cheerio.load(html);

  // Check result count (e.g. "顯示查詢結果 ( 找到 0 筆 )" or "找到 1 筆")
  let resultCount: number | null = null;
  $('.text-right-ISBN').each((_, el) => {
    const text = $(el).text();
    const match = text.match(/找到\s*(\d+)\s*筆/);
    if (match) {
      resultCount = parseInt(match[1], 10);
      return false; // Break loop
    }
  });

  if (resultCount === 0) {
    return null;
  }

  // Find the first data row in table.table-searchbooks (contains td cells, skipping header th row)
  const dataRows = $('table.table-searchbooks tr:has(td)');
  if (dataRows.length === 0) {
    return null;
  }
  const firstDataRow = dataRows.first();

  // Extract title
  const titleCell = firstDataRow.find('td[data-th="書名"]');
  const titleLink = titleCell.find('a');
  const title = (titleLink.length > 0 ? titleLink.text() : titleCell.text()).trim();

  // Extract authors
  const authors = firstDataRow.find('td[data-th="作者"]').text().trim();

  // Extract publisher
  const publisher = firstDataRow.find('td[data-th="出版者"]').text().trim();

  // Extract date (ROC era e.g. 115/10 -> Gregorian YYYY-MM e.g. 2026-10)
  const rawDate = firstDataRow.find('td[data-th="日期"]').text().trim();
  let published_date = rawDate;
  const dateMatch = rawDate.match(/^(\d+)\/(\d+)$/);
  if (dateMatch) {
    const rocYear = parseInt(dateMatch[1], 10);
    const gregorianYear = rocYear + 1911;
    const month = dateMatch[2].padStart(2, '0');
    published_date = `${gregorianYear}-${month}`;
  }

  // Extract cover URL
  const imgSrc = firstDataRow.find('td[data-th="封面圖"] img').attr('src')?.trim() || '';
  let cover_url = '';
  if (imgSrc && !imgSrc.includes('no_cover.png')) {
    cover_url = imgSrc;
  }

  return {
    title,
    authors,
    publisher,
    published_date,
    cover_url,
    isbn: requestedIsbn,
  };
}
