export type ReceivingData = {
 shipment_number: string; vehicle: number; warehouse: string; location: string | null; performer: string; document_date: string;
 lines: { id: string; product: string; quantity: number; damaged: number; expected: number; basis: string; shortage: number; overage: number; uom: string; batch: string | null; manufacture_date: string | null; expiry: string | null; reason: string | null }[];
};
const units: Record<string,string> = {piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
export function ReceivingPreview({preview:p}:{preview:ReceivingData}) {
 return <>
  <h4>Поставка {p.shipment_number} · автомобиль №{p.vehicle}</h4>
  <dl className="assistant-values"><div><dt>Склад назначения</dt><dd>{p.warehouse}</dd></div><div><dt>Зона</dt><dd>{p.location ?? "Без зоны — размещение не подтверждено"}</dd></div><div><dt>Исполнитель</dt><dd>{p.performer}</dd></div><div><dt>Дата операции</dt><dd>{p.document_date}</dd></div></dl>
  <p className="form-help">Ниже факты, сообщённые сотрудником, а не результат физической проверки ассистентом.</p>
  <ul>{p.lines.map(l=><li key={l.id}><strong>{l.product}</strong>
   <p>В годный остаток: <strong>{l.quantity} {units[l.uom] ?? l.uom}</strong> · повреждено: {l.damaged} {units[l.uom] ?? l.uom}</p>
   <p>Основа сравнения: {l.expected} {units[l.uom] ?? l.uom} — {l.basis==='shipped'?'отгружено':l.basis==='confirmed'?'подтверждено поставщиком (отгрузка не задана)':'заказано (подтверждение и отгрузка не заданы)'}. Недостача: {l.shortage}; излишек: {l.overage}.</p>
   <p>Партия: {l.batch ?? 'не создаётся'} · производство: {l.manufacture_date ?? 'не указано'} · годен до: {l.expiry ?? 'не указано'}</p>
   {l.reason && <p>Причина: {l.reason}</p>}
  </li>)}</ul>
  <p className="admin-message">После подтверждения создадутся акт, партии и движения прихода. Только годное количество увеличит доступный остаток; повреждения учитываются отдельно. Автомобиль станет разгруженным. Оплата и утверждение себестоимости не выполняются. Если данные изменились, потребуется новый просмотр.</p>
 </>;
}
