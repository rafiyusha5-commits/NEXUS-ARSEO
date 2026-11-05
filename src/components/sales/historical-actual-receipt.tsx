import { randomUUID } from "node:crypto";
import { recordHistoricalSaleReceipt } from "@/app/sales/actions";

export type ReceiptSnapshot = {
  items: { sku: string; uom: string; required_pct: number | null; reservations: {
    batch: string; expiry: string; sale_quantity: number; actual_pct: number;
  }[] }[];
};
export type ReceiptPreview = { token: string; valid: boolean; snapshot: ReceiptSnapshot };
export type ActualReceipt = { id: string; reason: string; created_at: string; created_by: string; snapshot: ReceiptSnapshot };

export function HistoricalActualReceipt({ saleId, status, canRecord, preview, error, receipts }: {
  saleId: string; status: string; canRecord: boolean; preview: ReceiptPreview | null;
  error: boolean; receipts: ActualReceipt[];
}) {
  const low = (snapshot: ReceiptSnapshot) => snapshot.items.flatMap(i => i.reservations
    .filter(r => i.required_pct != null && Number(r.actual_pct) < Number(i.required_pct))
    .map(r => ({ ...r, sku: i.sku, uom: i.uom, required: i.required_pct })));
  const details = (snapshot: ReceiptSnapshot) => <div className="import-table-wrap"><table className="import-table">
    <thead><tr><th>Артикул · партия</th><th>Годен до</th><th>Количество по заказу</th><th>ОСГ / требование</th></tr></thead>
    <tbody>{low(snapshot).map((r, n) => <tr key={`${r.sku}-${r.batch}-${n}`}><td>{r.sku} · {r.batch}</td><td>{r.expiry}</td>
      <td>{Number(r.sale_quantity).toLocaleString("ru-RU")} {({piece:"шт.",box:"кор.",pallet:"палл.",kg:"кг"} as Record<string,string>)[r.uom] ?? r.uom}</td><td>{r.actual_pct}% / {r.required}%</td></tr>)}</tbody>
  </table></div>;
  return <div className="admin-section">
    <h3>Фактическая приёмка исторической продажи</h3>
    <p className="form-help">Покупатель уже принял товар без гарантийного письма и предварительного согласования низкого ОСГ. Требование клиента и отклонения сохраняются. Доступно только администратору для ранее состоявшейся отгрузки.</p>
    {error && <p className="login-error">Не удалось проверить основание приёмки. Обновите страницу.</p>}
    {preview?.valid && <p className="form-help">Факт приёмки зафиксирован для текущих партий и количеств. Отклонения ОСГ остаются в истории.</p>}
    {!error && preview && !preview.valid && low(preview.snapshot).length > 0 && <>
      {details(preview.snapshot)}
      {canRecord && status === "reserved" && <form action={recordHistoricalSaleReceipt} className="reference-form">
        <input type="hidden" name="sale_id" value={saleId}/><input type="hidden" name="request_id" value={randomUUID()}/>
        <input type="hidden" name="expected_token" value={preview.token}/>
        <label>Основание фактической приёмки<textarea name="reason" required minLength={10} maxLength={2000} placeholder="Кто подтвердил факт, на каком основании и когда это стало известно"/></label>
        <label><input type="checkbox" name="acknowledged" required/> Подтверждаю фактическую приёмку указанных партий без гарантийного письма и предварительного согласования.</label>
        <button type="submit" className="secondary">Зафиксировать факт приёмки</button>
      </form>}
    </>}
    {receipts.map(r => <details key={r.id}><summary>Запись от {new Date(r.created_at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}</summary>
      <p>{r.reason}</p><p className="form-help">Внёс сотрудник: {r.created_by}. Гарантийного письма и предварительного согласования не было.</p>{details(r.snapshot)}
    </details>)}
  </div>;
}
