import { RETURN_DECISIONS } from "@/lib/agent/return-decisions";
export type ReturnDecisionData = { return_number: string; order_number: string; customer: string; product: string; batch: string;
 quantity: string; uom: string; batch_status: string; expiry: string | null; warehouse: string; location: string | null;
 decision: keyof typeof RETURN_DECISIONS; note: string | null; performer: string; document_date: string };
const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
const statuses: Record<string, string> = { available: "Доступна", depleted: "Израсходована", quarantine: "Карантин", blocked: "Заблокирована" };
export function ReturnDecisionPreview({ preview: p }: { preview: ReturnDecisionData }) {
 return <>
  <h4>{RETURN_DECISIONS[p.decision]} · возврат {p.return_number}</h4>
  <dl className="assistant-values"><div><dt>Покупатель / заказ</dt><dd>{p.customer} · {p.order_number}</dd></div><div><dt>Склад / зона</dt><dd>{p.warehouse} · {p.location ?? "Без зоны"}</dd></div>
   <div><dt>Исполнитель</dt><dd>{p.performer}</dd></div><div><dt>Дата</dt><dd>{p.document_date}</dd></div></dl>
  <p><strong>{p.product} · {p.batch} — {p.quantity} {units[p.uom] ?? p.uom}</strong><br />Вся позиция возврата, без изменения количества или партии.</p>
  <p>Статус партии: {statuses[p.batch_status] ?? p.batch_status}. Годен до: {p.expiry ?? "не указан"}.</p>
  <p>Причина / комментарий: {p.note ?? "Без комментария"}</p>
  <p role="note" className="admin-message">{p.decision === "restock"
   ? "Количество будет зачислено в исходную партию на указанный склад. Блокировка и карантин партии сохраняются; израсходованная партия станет доступной. Срок годности и ОСГ по-прежнему ограничивают продажу — это решение не разрешает их обход."
   : p.decision === "write_off" ? "Будет зафиксировано списание всей позиции из карантина. Прихода в свободный остаток и повторного списания со склада не будет."
   : "Будет зафиксировано решение вернуть всю позицию поставщику. Прихода на склад не будет. Штатная операция не создаёт перевозку, отгрузочный документ или расчёты с поставщиком."}</p>
  <p className="form-help">Решение окончательное для этой позиции. Возврат закроется, когда обработаны все позиции. Долг покупателя повторно не уменьшается, выплата денег не создаётся. При изменении данных или прав потребуется новый просмотр.</p>
 </>;
}
