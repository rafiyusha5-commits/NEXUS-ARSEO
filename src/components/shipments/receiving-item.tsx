"use client";

import { useRef, useState } from "react";

/** `batches`: the batches of the packing list still expected (202611280700) — one row each, filled in advance. */
export function ReceivingItem({ itemId, title, expected, unit, batches = [] }: {
  itemId: string; title: string; expected: number; unit: string;
  batches?: Array<{ expected: string; batch: string; expiry: string; manufactured: string; code: string | null }>;
}) {
  const [rows, setRows] = useState(() => batches.length ? batches.map((_, index) => index) : [0]);
  const nextId = useRef(Math.max(batches.length, 1));
  const preset = (id: number) => batches[id];
  return <fieldset className="receiving-item"><legend><strong>{title}</strong>
    <small>Ожидается {expected.toLocaleString("ru-RU")} {unit}</small></legend>
    <p className="form-help">Разные номера партий или сроки годности указывайте отдельными строками. Сумма «По документу» должна совпадать с количеством позиции.</p>
    {batches.length > 0 && <p className="form-help">Партии по упаковочному листу подставлены{batches.some(batch => batch.code) ? ", на них напечатаны наклейки" : ""}: проверьте номер, срок и количество. Наклейка привяжется к партии, только если номер и срок совпадут с листом.</p>}
    {rows.map((id, index) => <fieldset key={id} className="receiving-item"><legend>Партия {index + 1}{preset(id)?.code ? ` · наклейка ${preset(id).code}` : ""}</legend>
      <input type="hidden" name="item_id" value={itemId}/>
      <div className="receiving-item-grid">
        <label>По документу<input name="expected_quantity" type="number" min="0.001" step="0.001" defaultValue={preset(id) ? preset(id).expected : id === 0 ? expected : ""} required/></label>
        <label>Принято<input name="accepted_quantity" type="number" min="0" step="0.001" defaultValue={preset(id) ? preset(id).expected : id === 0 ? expected : ""} required/></label>
        <label>Повреждено<input name="damaged_quantity" type="number" min="0" step="0.001" defaultValue="0" required/></label>
        <label>Номер партии<input name="batch_number" placeholder="Номер из упаковочного листа" defaultValue={preset(id)?.batch ?? ""}/></label>
        <label>Дата производства<input name="manufacture_date" type="date" defaultValue={preset(id)?.manufactured ?? ""}/></label>
        <label>Срок годности<input name="expiry_date" type="date" defaultValue={preset(id)?.expiry ?? ""}/></label>
        <label className="receiving-reason">Причина расхождения<input name="discrepancy_reason" placeholder="Недостача, бой, излишек…"/></label>
      </div>
      {rows.length > 1 && <button type="button" className="secondary compact" onClick={() => setRows(rows.filter(row => row !== id))}>Убрать партию {index + 1}</button>}
    </fieldset>)}
    <button type="button" className="secondary compact" disabled={rows.length >= 100} onClick={() => { const id = nextId.current++; setRows([...rows, id]); }}>Добавить партию</button>
  </fieldset>;
}
