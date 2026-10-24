import { RETURN_REASONS } from "@/lib/agent/returns";
export type ReturnData = {
 order_number: string; customer: string; warehouse: string; performer: string; document_date: string;
 reason: string; total: string; currency: string;
 lines: { sale_item_id: string; batch_id: string; product_name: string; batch_number: string; uom: string; shipped: number; returned: number; available: number; quantity: string; reason_code: keyof typeof RETURN_REASONS; unit_price: string; amount: string }[];
};
const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
export function ReturnPreview({ preview: p }: { preview: ReturnData }) {
 return <>
  <h4>Возврат по заказу {p.order_number}</h4>
  <dl className="assistant-values"><div><dt>Покупатель</dt><dd>{p.customer}</dd></div><div><dt>Склад</dt><dd>{p.warehouse}</dd></div>
   <div><dt>Дата</dt><dd>{p.document_date}</dd></div><div><dt>Оформляет</dt><dd>{p.performer}</dd></div></dl>
  <p>Причина: {p.reason}</p>
  <ul>{p.lines.map(l => <li key={`${l.sale_item_id}:${l.batch_id}`}>
   <strong>{l.product_name} · {l.batch_number}: вернуть {l.quantity} {units[l.uom] ?? l.uom}</strong><br />
   Отгружено: {l.shipped}; ранее возвращено: {l.returned}; доступно к возврату: {l.available} {units[l.uom] ?? l.uom}.<br />
   Причина: {RETURN_REASONS[l.reason_code]}; цена заказа: {l.unit_price} {p.currency}; сумма: {l.amount} {p.currency}.
  </li>)}</ul>
  <p><strong>Сумма возврата: {p.total} {p.currency}</strong></p>
  <p role="note" className="admin-message">Товар попадёт в карантин, не в свободный остаток. Сумма возврата уменьшит долг покупателя по штатным правилам. Выплата денег не создаётся. Возврат в продажу, списание и возврат поставщику требуют отдельных решений и прав.</p>
  <p className="form-help">При изменении заказа, партий, прежних возвратов или прав потребуется новый предпросмотр.</p>
 </>;
}
