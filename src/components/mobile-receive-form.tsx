"use client";

// Receiving a truck from a phone (202611280600): the existing receive_shipment_transport with its form fields. A scan of a
// GS1 code on a box fills the batch and the expiry into the line of its product (a second batch of the same product gets
// its own line); a plain barcode finds the line. Nothing is written until «Завершить приёмку».
import { useState } from "react";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { ScanFeedback } from "@/components/scan-feedback";
import { ScanField } from "@/components/scan-field";
import { gs1ErrorText, looksLikeGs1, parseGs1 } from "@/lib/scan/gs1";
import { matchReceiving } from "@/lib/scan/operations";

export type ReceiveItem = { item_id: string; title: string; expected: number; unit: string; codes: string[] };
export type ReceiveLocation = { id: string; code: string; zone: string };
type Row = { key: number; expected: string; accepted: string; damaged: string; batch: string; manufactured: string; expiry: string; reason: string };
type Action = (data: FormData) => void | Promise<void>;

const shortDate = (value: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

export function MobileReceiveForm({ shipmentId, transportId, items, locations, performer, action }: {
  shipmentId: string; transportId: string; items: ReceiveItem[]; locations: ReceiveLocation[]; performer: string; action: Action;
}) {
  const [rows, setRows] = useState<Record<string, Row[]>>(() => Object.fromEntries(items.map(item =>
    [item.item_id, [{ key: 0, expected: String(item.expected), accepted: String(item.expected), damaged: "0", batch: "", manufactured: "", expiry: "", reason: "" }]])));
  const [next, setNext] = useState(1);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; at: number; item?: string } | null>(null);

  const update = (itemId: string, key: number, patch: Partial<Row>) =>
    setRows(current => ({ ...current, [itemId]: current[itemId].map(row => row.key === key ? { ...row, ...patch } : row) }));

  const onCode = (raw: string) => {
    const at = Date.now();
    const gs1 = looksLikeGs1(raw) ? parseGs1(raw) : null;
    if (gs1 && !gs1.ok) { setNotice({ ok: false, text: gs1ErrorText[gs1.error], at }); return; }
    const code = gs1?.ok && gs1.gtin ? gs1.gtin : raw;
    const matched = matchReceiving(items, code);
    if (!matched.length) { setNotice({ ok: false, text: "Код не относится к товарам этого автомобиля", at }); return; }
    const item = items.find(entry => entry.item_id === matched[0])!;
    const batch = gs1?.ok ? gs1.batch : null;
    const expiry = gs1?.ok ? gs1.expiry : null;
    if (!batch && !expiry) { setNotice({ ok: true, text: `${item.title}: введите партию и срок`, at, item: item.item_id }); focus(item.item_id); return; }
    const lines = rows[item.item_id];
    const same = batch ? lines.find(row => row.batch === batch) : undefined;
    const empty = lines.find(row => !row.batch && !row.expiry);
    const filled = `${batch ? `партия ${batch}` : ""}${batch && expiry ? ", " : ""}${expiry ? `срок ${shortDate(expiry)}` : ""}`;
    if (same) {
      if (expiry && !same.expiry) update(item.item_id, same.key, { expiry });
      setNotice({ ok: true, text: `${item.title}: ${filled} — уже в строке`, at, item: item.item_id });
    } else if (empty) {
      update(item.item_id, empty.key, { batch: batch ?? "", expiry: expiry ?? "" });
      setNotice({ ok: true, text: `${item.title}: ${filled} подставлены`, at, item: item.item_id });
    } else {
      const key = next;
      setNext(key + 1);
      setRows(current => ({ ...current, [item.item_id]: [...current[item.item_id],
        { key, expected: "", accepted: "", damaged: "0", batch: batch ?? "", manufactured: "", expiry: expiry ?? "", reason: "" }] }));
      setNotice({ ok: true, text: `${item.title}: новая партия, ${filled} — разделите количество по партиям`, at, item: item.item_id });
    }
    focus(item.item_id);
  };

  return <>
    <ScanField label="Сканируйте коробку: партия и срок подставятся" placeholder="GS1-код или штрихкод товара" onCode={onCode}/>
    {notice && <><ScanFeedback ok={notice.ok} signature={String(notice.at)}/>
      <p className={notice.ok ? "login-success admin-message" : "login-error admin-message"} role="status">{notice.text}</p></>}
    <form action={action} className="mobile-form">
      <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="transport_id" value={transportId}/>
      {items.map(item => <fieldset key={item.item_id} id={`receive-${item.item_id}`} className={`mobile-card mobile-receive${notice?.item === item.item_id ? " mobile-card-ok" : ""}`}>
        <legend className="mobile-big">{item.title}</legend>
        <small>Ожидается {item.expected.toLocaleString("ru-RU")} {item.unit}</small>
        {rows[item.item_id].map((row, index) => <div key={row.key} className="mobile-receive-row">
          {rows[item.item_id].length > 1 && <strong>Партия {index + 1}</strong>}
          <input type="hidden" name="item_id" value={item.item_id}/>
          <div className="mobile-receive-grid">
            <label>По документу<input name="expected_quantity" inputMode="decimal" required value={row.expected} onChange={event => update(item.item_id, row.key, { expected: event.target.value })}/></label>
            <label>Принято<input name="accepted_quantity" inputMode="decimal" required value={row.accepted} onChange={event => update(item.item_id, row.key, { accepted: event.target.value })}/></label>
            <label>Повреждено<input name="damaged_quantity" inputMode="decimal" required value={row.damaged} onChange={event => update(item.item_id, row.key, { damaged: event.target.value })}/></label>
          </div>
          <label>Номер партии<input name="batch_number" autoCapitalize="characters" value={row.batch} onChange={event => update(item.item_id, row.key, { batch: event.target.value })}/></label>
          <div className="mobile-receive-grid two">
            <label>Произведён<input name="manufacture_date" type="date" value={row.manufactured} onChange={event => update(item.item_id, row.key, { manufactured: event.target.value })}/></label>
            <label>Годен до<input name="expiry_date" type="date" value={row.expiry} onChange={event => update(item.item_id, row.key, { expiry: event.target.value })}/></label>
          </div>
          <label>Причина расхождения<input name="discrepancy_reason" placeholder="Недостача, бой, излишек…" value={row.reason} onChange={event => update(item.item_id, row.key, { reason: event.target.value })}/></label>
          {rows[item.item_id].length > 1 && <button type="button" className="ghost" onClick={() => setRows(current => ({ ...current, [item.item_id]: current[item.item_id].filter(entry => entry.key !== row.key) }))}>Убрать партию {index + 1}</button>}
        </div>)}
        <button type="button" className="secondary" disabled={rows[item.item_id].length >= 100} onClick={() => {
          const key = next; setNext(key + 1);
          setRows(current => ({ ...current, [item.item_id]: [...current[item.item_id], { key, expected: "", accepted: "", damaged: "0", batch: "", manufactured: "", expiry: "", reason: "" }] }));
        }}>Добавить партию</button>
      </fieldset>)}
      <label>Место приёмки<select name="location_id" defaultValue=""><option value="">Без зоны</option>{locations.map(location =>
        <option key={location.id} value={location.id}>{location.code} · {location.zone}</option>)}</select></label>
      <label>Исполнитель<input name="performed_by_name" defaultValue={performer} required/></label>
      <label>Примечание<input name="notes" placeholder="Пломба, температура, акт…"/></label>
      <PendingSubmitButton pendingText="Проводим приёмку…" className="primary scan-button" type="submit">Завершить приёмку</PendingSubmitButton>
      <p className="mobile-hint">Все позиции автомобиля принимаются одним действием. При недостаче, излишке или повреждении укажите причину. В остаток попадает только принятое количество.</p>
    </form>
  </>;
}

function focus(itemId: string) {
  requestAnimationFrame(() => document.getElementById(`receive-${itemId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
