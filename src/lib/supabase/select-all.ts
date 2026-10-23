// Complete reference lists (audit 2026-10-13, finding Н8). The API returns at most 1000 rows per request, so a
// product or counterparty list loaded in one request was cut after 1000 records without any sign. selectAll reads
// the query page by page until a page comes back short.

export const PAGE_SIZE = 1000;
// A guard against a runaway list. Never return a partial list as usable data.
export const MAX_ROWS = 50_000;

type PageResult<T, E> = { data: T[] | null; error: E | null };

/**
 * Reads every row of a query. `page(from, to)` builds the query with `.range(from, to)`; its order has to be total
 * (end it with a unique column such as `id`) so that pages neither skip nor repeat rows. On an error the result is
 * `{ data: null, error }`, as for a single request.
 */
export async function selectAll<T, E>(
  page: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
  pageSize = PAGE_SIZE,
  maxRows = MAX_ROWS,
): Promise<{ data: T[] | null; error: E | null; truncated: boolean }> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > PAGE_SIZE || !Number.isSafeInteger(maxRows) || maxRows <= 0) {
    throw new RangeError("Invalid reference list limits");
  }
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const size = Math.min(pageSize, maxRows - from);
    const { data, error } = await page(from, from + size - 1);
    if (error) return { data: null, error, truncated: false };
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < size) return { data: rows, error: null, truncated: false };
  }
  const extra = await page(maxRows, maxRows);
  if (extra.error) return { data: null, error: extra.error, truncated: false };
  if (!extra.data?.length) return { data: rows, error: null, truncated: false };
  throw new Error(`Справочник превышает ${maxRows} записей: полный список не загружен. Операция остановлена.`);
}
