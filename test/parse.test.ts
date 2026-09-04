import { describe, it, expect } from 'vitest';
import { parseSearchResult } from '../src/parse';

/** Builds a results page shaped like ISBNnet's, with only the parts the
 *  parser looks at. */
function resultsPage(opts: {
  count?: number | string;
  rows?: string[];
  countMarkup?: string;
}): string {
  const count = opts.countMarkup ??
    (opts.count === undefined ? '' : `<div class="text-right-ISBN">顯示查詢結果 ( 找到 ${opts.count} 筆 )</div>`);
  const rows = (opts.rows ?? []).join('\n');
  return `<html><body>
    ${count}
    <table class="table-searchbooks">
      <tr><th>封面圖</th><th>書名</th><th>作者</th><th>出版者</th><th>日期</th></tr>
      ${rows}
    </table>
  </body></html>`;
}

function row(cells: {
  title?: string;
  titleLink?: string;
  authors?: string;
  publisher?: string;
  date?: string;
  cover?: string;
}): string {
  const titleCell = cells.titleLink !== undefined
    ? `<a href="/detail">${cells.titleLink}</a>`
    : (cells.title ?? '');
  const img = cells.cover !== undefined ? `<img src="${cells.cover}">` : '';
  return `<tr>
    <td data-th="封面圖">${img}</td>
    <td data-th="書名">${titleCell}</td>
    <td data-th="作者">${cells.authors ?? ''}</td>
    <td data-th="出版者">${cells.publisher ?? ''}</td>
    <td data-th="日期">${cells.date ?? ''}</td>
  </tr>`;
}

const ISBN = '9789571234567';

describe('parseSearchResult', () => {
  describe('when there is no match', () => {
    it('returns null on an explicit zero-result count', () => {
      expect(parseSearchResult(resultsPage({ count: 0 }), ISBN)).toBeNull();
    });

    it('returns null when the table has no data rows', () => {
      // Header-only table: the th row must not be mistaken for a result.
      expect(parseSearchResult(resultsPage({ count: 1, rows: [] }), ISBN)).toBeNull();
    });

    it('returns null when the page has no table at all', () => {
      expect(parseSearchResult('<html><body>維護中</body></html>', ISBN)).toBeNull();
    });
  });

  describe('field extraction', () => {
    const html = resultsPage({
      count: 1,
      rows: [row({
        titleLink: '資料結構與演算法',
        authors: '王小明',
        publisher: '天下文化',
        date: '115/10',
        cover: 'https://isbn.ncl.edu.tw/covers/abc.jpg',
      })],
    });

    it('reads every field off the first data row', () => {
      expect(parseSearchResult(html, ISBN)).toEqual({
        title: '資料結構與演算法',
        authors: '王小明',
        publisher: '天下文化',
        published_date: '2026-10',
        cover_url: 'https://isbn.ncl.edu.tw/covers/abc.jpg',
        isbn: ISBN,
      });
    });

    it('echoes back the ISBN that was asked for, not one read off the page', () => {
      // The results page does not carry the ISBN in a cell the parser reads,
      // so the caller's value is the only correct answer here.
      expect(parseSearchResult(html, '9781234567897')!.isbn).toBe('9781234567897');
    });

    it('takes the title from the link when the cell has one', () => {
      const withLink = resultsPage({ count: 1, rows: [row({ titleLink: '  書名  ' })] });
      expect(parseSearchResult(withLink, ISBN)!.title).toBe('書名');
    });

    it('falls back to the cell text when the title is not a link', () => {
      const noLink = resultsPage({ count: 1, rows: [row({ title: '  沒有連結的書名  ' })] });
      expect(parseSearchResult(noLink, ISBN)!.title).toBe('沒有連結的書名');
    });

    it('takes the first data row when several match', () => {
      const many = resultsPage({
        count: 3,
        rows: [row({ titleLink: '第一筆' }), row({ titleLink: '第二筆' })],
      });
      expect(parseSearchResult(many, ISBN)!.title).toBe('第一筆');
    });
  });

  describe('ROC era dates', () => {
    const dateOf = (date: string) =>
      parseSearchResult(resultsPage({ count: 1, rows: [row({ date })] }), ISBN)!.published_date;

    it('converts a ROC year to the Gregorian one', () => {
      // 民國 115 = 2026. Getting the 1911 offset wrong by one is the classic
      // failure here, so pin both a recent year and an old one.
      expect(dateOf('115/10')).toBe('2026-10');
      expect(dateOf('90/6')).toBe('2001-06');
      expect(dateOf('1/1')).toBe('1912-01');
    });

    it('pads a single-digit month', () => {
      expect(dateOf('115/1')).toBe('2026-01');
      expect(dateOf('115/09')).toBe('2026-09');
    });

    it('leaves a date it does not recognise alone rather than guessing', () => {
      expect(dateOf('2026-10')).toBe('2026-10');
      expect(dateOf('115')).toBe('115');
      expect(dateOf('民國115年10月')).toBe('民國115年10月');
      expect(dateOf('')).toBe('');
    });
  });

  describe('cover image', () => {
    const coverOf = (cover?: string) =>
      parseSearchResult(resultsPage({ count: 1, rows: [row({ cover })] }), ISBN)!.cover_url;

    it('keeps a real cover URL', () => {
      expect(coverOf('https://isbn.ncl.edu.tw/covers/x.jpg')).toBe('https://isbn.ncl.edu.tw/covers/x.jpg');
    });

    it('drops the placeholder rather than passing it off as artwork', () => {
      // no_cover.png is what ISBNnet serves when it has no image; returning it
      // would make every coverless book look like it had one.
      expect(coverOf('/images/no_cover.png')).toBe('');
      expect(coverOf('https://isbn.ncl.edu.tw/assets/no_cover.png?v=2')).toBe('');
    });

    it('is empty when the row has no image at all', () => {
      expect(coverOf(undefined)).toBe('');
    });
  });
});
