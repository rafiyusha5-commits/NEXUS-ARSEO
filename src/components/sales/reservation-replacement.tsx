"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { previewReservationReplacement, commitReservationReplacement } from "@/app/sales/replacement-actions";
import { candidateWarning, replacementUnits as units, type Allocation, type ReplacementPreview } from "@/lib/sales/reservation-replacement";

export function ReservationReplacement({ saleId }: { saleId: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ preview: ReplacementPreview; allocations: Allocation[]; id: string; reason: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // Only a click performs a read; mounting/opening a page never replaces anything.
  async function load() {
    setBusy(true); setMessage(""); setReview(null);
    try {
      const result = await previewReservationReplacement(saleId);
      if (result.error) { setPreview(null); setMessage(result.error); }
      else { setPreview(result.data!); setSelected({}); setAmounts({}); }
    } catch { setMessage("Не удалось загрузить варианты. Проверьте соединение и повторите."); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!preview) return;
    const allocations = preview.snapshot.items.filter(i => selected[i.id]).flatMap(i => preview.snapshot.balances
      .filter(b => b.product_id === i.product_id && Number(amounts[`${i.id}:${b.id}`]) > 0)
      .map(b => ({ item_id: i.id, balance_id: b.id, sale_quantity: Number(amounts[`${i.id}:${b.id}`]) })));
    if (!reason.trim() || !allocations.length || preview.snapshot.items.some(i => selected[i.id] && !allocations.some(a => a.item_id === i.id))) {
      setMessage("Укажите причину и распределение для каждой выбранной позиции."); return;
    }
    setBusy(true); setReview(null); setMessage("");
    try {
      const result = await previewReservationReplacement(saleId, allocations);
      if (result.error) setMessage(result.error);
      else { setPreview(result.data!); setReview({ preview: result.data!, allocations, id: crypto.randomUUID(), reason: reason.trim() }); }
    } catch { setMessage("Проверка не выполнена. Проверьте соединение и повторите."); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!review) return;
    setBusy(true); setMessage("");
    try {
      const result = await commitReservationReplacement(saleId, review.id, review.preview.snapshot, review.allocations, review.reason);
      if (result.error) setMessage(result.error);
      else { setMessage("Партии заменены. Заказ остаётся подтверждённым. Физические остатки не изменены."); setReview(null); setPreview(null); router.refresh(); }
    } catch {
      // Keep the exact request ID and payload: retry acknowledges the original transaction, never re-reserves.
      setMessage("Ответ не получен. Повторите подтверждение с тем же запросом: операция защищена от повтора.");
    } finally { setBusy(false); }
  }
  return <section className="reservation-replacement" aria-label="Замена партий">
    <button className="secondary" onClick={load} disabled={busy}>{preview ? "Обновить варианты" : "Заменить партии"}</button>
    <p className="form-help">Только на складе заказа. Замена требует права ручного выбора партии; гарантийное письмо не переносится. Другие позиции сохранят свои резервы.</p>
    {message && <p role="status" className="replacement-message">{message}</p>}
    {preview && <>
      <p>Дата проверки ОСГ: {preview.snapshot.order.date > preview.snapshot.order.today ? preview.snapshot.order.date : preview.snapshot.order.today}. Партии ниже расположены по ближайшему сроку годности.</p>
      <fieldset disabled={busy || !!review} className="replacement-fields">
        {preview.snapshot.items.map(item => <article key={item.id} className="replacement-item">
          <label className="replacement-select"><input type="checkbox" checked={!!selected[item.id]} onChange={e => setSelected({ ...selected, [item.id]: e.target.checked })}/><strong>{item.sku} · {item.quantity} {units[item.uom]}</strong></label>
          <h4>Сейчас зарезервировано</h4>
          {preview.snapshot.reservations.filter(r => r.item_id === item.id).map(r => {
            const balance = preview.snapshot.balances.find(b => b.id === r.balance_id);
            const warning = balance ? candidateWarning(balance, item, preview.snapshot.order) : "Остаток недоступен на складе заказа";
            return <p key={r.id}>{r.batch_number}: {r.quantity} {units[r.uom]} = {r.sale_quantity} {units[item.uom]}{warning && <small className="danger-text"> · {warning}</small>}</p>;
          })}
          {selected[item.id] && <><h4>Новое распределение · в единицах заказа</h4><div className="replacement-options">
            {preview.snapshot.balances.filter(b => b.product_id === item.product_id).map(b => {
              const warning = candidateWarning(b, item, preview.snapshot.order);
              const own = preview.snapshot.reservations.filter(r => r.item_id === item.id && r.balance_id === b.id).reduce((s, r) => s + Number(r.quantity), 0);
              return <label key={b.id} className="replacement-option"><span><strong>{b.batch_number}</strong><small>До {b.expiry} · ОСГ {b.pct}% / требуется {item.required_pct ?? "не задано"}%</small><small>Свободно {b.free} {units[b.uom]} · ваш текущий резерв {own} {units[b.uom]}</small>{warning && <small className="danger-text">{warning}</small>}</span><span>Количество, {units[item.uom]}<input aria-label={`${item.sku}, ${b.batch_number}, количество`} type="number" min="0" step="0.001" value={amounts[`${item.id}:${b.id}`] ?? ""} onChange={e => setAmounts({ ...amounts, [`${item.id}:${b.id}`]: e.target.value })} disabled={b.status !== "available" || b.expiry < (preview.snapshot.order.date > preview.snapshot.order.today ? preview.snapshot.order.date : preview.snapshot.order.today)}/></span></label>;
            })}
          </div></>}
        </article>)}
        <label>Обязательная причина<textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={500} required/></label>
        <button className="secondary" onClick={check} type="button">Проверить распределение</button>
      </fieldset>
      {review && <div className="replacement-review"><h3>Проверьте перед подтверждением</h3>
        {review.preview.plan?.map(row => <p key={`${row.item_id}:${row.balance_id}`}><strong>{row.sku} · {row.batch_number}</strong><br/>{row.sale_quantity} {units[row.sale_uom]} заказа = {row.quantity} {units[row.uom]} на складе · ОСГ {row.pct}%</p>)}
        <p>Причина: {review.reason}</p><p className="form-help">Старые резервы выбранных позиций будут освобождены. При ошибке вся замена откатится. Повторное подтверждение одного запроса не создаёт новых резервов.</p>
        <button className="primary" disabled={busy} onClick={commit}>Подтвердить замену</button>{" "}<button className="secondary" disabled={busy} onClick={() => setReview(null)}>Изменить распределение</button>
      </div>}
    </>}
  </section>;
}
