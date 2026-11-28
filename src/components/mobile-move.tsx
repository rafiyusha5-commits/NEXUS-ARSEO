// Moving stock between places of one warehouse from a phone (202611280600): where from (a scan of a place, a batch or a
// product), where to (a scan of the place label or a choice from the list), how much. Rendering only; the move is a
// posted transfer document, every check is the database's.
import Link from "next/link";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { ScanFeedback } from "@/components/scan-feedback";
import { ScanField } from "@/components/scan-field";
import { quantity, shortDate, uomName, type StockRow } from "@/lib/scan/lookup";

type Action = (data: FormData) => void | Promise<void>;
export type MoveBalance = {
  id: string; warehouse_id: string; warehouse: string; location_id: string | null; location: string | null; sku: string; product: string;
  batch: string; expiry_date: string | null; batch_status: string; uom: string; on_hand: number; reserved: number;
};
export type MoveLocation = { id: string; code: string; zone: string };
const unit = (uom: string) => uom === "piece" ? "шт." : uomName[uom] ?? uom;

export function MoveView({ code, sources, balance, locations = [], destination, warning, message, moveAction }: {
  code?: string; sources?: StockRow[] | null; balance?: MoveBalance | null; locations?: MoveLocation[]; destination?: MoveLocation | null;
  warning?: string | null; message?: { type: "error" | "success"; text: string } | null; moveAction: Action;
}) {
  const free = balance ? Math.max(0, balance.on_hand - balance.reserved) : 0;
  return <>
    <h1 className="mobile-title">Перемещение</h1>
    {message && <div className={`${message.type === "error" ? "login-error" : "login-success"} admin-message`}>{message.text}</div>}
    {!balance && <>
      <ScanField target="/m/move" label="Откуда: отсканируйте место, партию или товар" placeholder="Этикетка места, партии или код"/>
      {sources && (sources.length ? <section className="mobile-card"><ScanFeedback ok signature={`${code}:sources`}/><strong>Что перемещаем</strong>
        <ul className="mobile-stock">{sources.map(row => <li key={row.balance_id}>
          <div><strong>{row.location ?? "без зоны"} · {row.sku}</strong><small>{row.product}</small><small>партия {row.batch} · до {shortDate(row.expiry_date)}</small>
            <Link className="secondary button-link mobile-pick-button" href={`/m/move?balance=${row.balance_id}`}>Переместить отсюда</Link></div>
          <div className="mobile-qty"><strong>{quantity(row.free)}</strong><small>свободно {unit(row.uom)}</small></div>
        </li>)}</ul></section>
        : <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={`${code}:none`}/><strong>Свободного остатка нет</strong>
          <small>Зарезервированное под заказы не перемещается — сначала снимите или замените резерв.</small></section>)}
      {!sources && <p className="mobile-hint">Перемещение внутри склада проводится документом перемещения сразу: номер, исполнитель, отмена с возвратом — как в полной версии. Между складами — документом перемещения в полной версии.</p>}
    </>}
    {balance && <>
      <section className="mobile-card"><small>Откуда</small>
        <strong className="mobile-big">{balance.location ?? "без зоны"} · {balance.sku}</strong>
        <span>{balance.product}</span>
        <small>{balance.warehouse} · партия {balance.batch} · до {shortDate(balance.expiry_date)} · свободно {quantity(free)} из {quantity(balance.on_hand)} {unit(balance.uom)}</small>
        <Link href="/m/move">Выбрать другое</Link>
      </section>
      {!destination && <>
        <ScanField target={`/m/move?balance=${balance.id}`} label="Куда: отсканируйте этикетку места" placeholder="Этикетка места"/>
        {warning && <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={`${code}:${warning}`}/><strong>{warning}</strong></section>}
        <form className="mobile-form" action="/m/move"><input type="hidden" name="balance" value={balance.id}/>
          <label>или выберите место<select name="to" required defaultValue="">
            <option value="" disabled>Место склада {balance.warehouse}</option>
            {locations.filter(location => location.id !== balance.location_id).map(location => <option key={location.id} value={location.id}>{location.code} · {location.zone}</option>)}
          </select></label>
          <button className="secondary scan-button" type="submit">Выбрать</button>
        </form>
      </>}
      {destination && <section className="mobile-card mobile-card-ok"><ScanFeedback ok signature={`${balance.id}:${destination.id}`}/><small>Куда</small>
        <strong className="mobile-big">Место {destination.code}</strong>
        <form action={moveAction} className="mobile-form">
          <input type="hidden" name="balance_id" value={balance.id}/><input type="hidden" name="to_location_id" value={destination.id}/>
          <label>Сколько, {unit(balance.uom)}<input name="quantity" inputMode="decimal" required defaultValue={String(free)} autoFocus/></label>
          <label>Примечание<input name="note" maxLength={500} placeholder="Необязательно"/></label>
          <PendingSubmitButton pendingText="Перемещаем…" className="primary scan-button" type="submit">Переместить</PendingSubmitButton>
        </form>
        <Link href={`/m/move?balance=${balance.id}`}>Другое место</Link>
      </section>}
    </>}
    <p><Link href="/m">← Склад</Link></p>
  </>;
}
