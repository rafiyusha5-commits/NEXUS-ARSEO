import Link from "next/link";
import { pageHref, pageSummary, type PageWindow } from "@/lib/pagination";

// «Показано 101–200 из 1 234» with links to the previous and next page of the same list (src/lib/pagination.ts).
export function ListPager({ pathname, params, current, total, shown, anchor = "" }: {
  pathname: string;
  params: Record<string, string | string[] | undefined>;
  current: PageWindow;
  total: number;
  shown: number;
  anchor?: string;
}) {
  const summary = pageSummary(current, total, shown);
  if (summary.pages <= 1 && current.page === 1) return null;
  const number = (value: number) => value.toLocaleString("ru-RU");
  return (
    <nav className="list-pager" aria-label="Страницы списка">
      <span>{shown ? `Показано ${number(summary.first)}–${number(summary.last)} из ${number(summary.total)}` : `На этой странице ничего нет: всего ${number(summary.total)}`}</span>
      {summary.previous !== null && <Link className="ghost button-link compact" href={pageHref(pathname, params, summary.previous) + anchor}>← Назад</Link>}
      {summary.next !== null && <Link className="ghost button-link compact" href={pageHref(pathname, params, summary.next) + anchor}>Дальше →</Link>}
    </nav>
  );
}
