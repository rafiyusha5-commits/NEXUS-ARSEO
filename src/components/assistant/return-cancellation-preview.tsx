export type ReturnCancellationData = { return_number: string; order_number: string; customer: string; warehouse: string;
 reason: string; total: string; currency: string; performer: string; document_date: string;
 lines: { id: string; product: string; batch: string; quantity: string; uom: string; amount: string }[] };
const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
export function ReturnCancellationPreview({ preview: p }: { preview: ReturnCancellationData }) {
 return <>
  <h4>Отменить возврат {p.return_number} полностью</h4>
  <dl className="assistant-values"><div><dt>Покупатель / заказ</dt><dd>{p.customer} · {p.order_number}</dd></div>
   <div><dt>Склад</dt><dd>{p.warehouse}</dd></div><div><dt>Исполнитель</dt><dd>{p.performer}</dd></div><div><dt>Дата</dt><dd>{p.document_date}</dd></div></dl>
  <p>Причина отмены: {p.reason}</p>
  <ul>{p.lines.map(l => <li key={l.id}><strong>{l.product} · {l.batch}</strong> — {l.quantity} {units[l.uom] ?? l.uom}; {l.amount} {p.currency}</li>)}</ul>
  <p role="note" className="admin-message">Уменьшение задолженности на {p.total} {p.currency}, связанное с этим возвратом, перестанет учитываться. Эти количества снова будут доступны для оформления возврата по заказу.</p>
  <p className="form-help">Отменяется весь возврат, без удаления истории. Складской остаток, резервы и платежи не меняются; выплата денег и физическая отгрузка не создаются. Отмена невозможна, если хотя бы по одной позиции уже принято решение. При изменении данных или прав потребуется новый просмотр.</p>
 </>;
}

