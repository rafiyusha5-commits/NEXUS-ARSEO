// Page-by-page lists (performance measurement 25.11.2026, point 4). A list page reads one page of rows with an exact
// count instead of the whole table; PostgREST returns at most 1000 rows per request, so whole-table reads were also
// cut silently after 1000 rows. Pure functions: the page number comes from the URL (?page=), 1-based.

export const PAGE_SIZE = 100;

export type PageWindow = { page: number; size: number; from: number; to: number };

/** The rows of a page for `.range(from, to)`; anything that is not a positive whole number is the first page. */
export function pageWindow(param: string | string[] | undefined, size = PAGE_SIZE): PageWindow {
  const raw = Array.isArray(param) ? param[0] : param;
  const parsed = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  const page = Math.max(1, parsed);
  return { page, size, from: (page - 1) * size, to: page * size - 1 };
}

/** The same list on another page: every other query parameter is kept; page 1 has no parameter. */
export function pageHref(pathname: string, params: Record<string, string | string[] | undefined>, page: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page" || key === "error" || key === "success" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}

export type PageSummary = { first: number; last: number; total: number; pages: number; previous: number | null; next: number | null };

/** «Показано first–last из total» and the neighbouring pages; a page past the end shows nothing and links back. */
export function pageSummary(current: PageWindow, total: number, shown: number): PageSummary {
  const pages = Math.max(1, Math.ceil(total / current.size));
  return {
    first: shown ? current.from + 1 : 0,
    last: current.from + shown,
    total,
    pages,
    previous: current.page > 1 ? Math.min(current.page - 1, pages) : null,
    next: current.page < pages ? current.page + 1 : null,
  };
}
