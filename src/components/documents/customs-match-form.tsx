"use client";
import { useState } from "react";
import { saveCustomsMatchAction } from "@/app/shipments/source-document-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { isCommodityInvoice, isCommodityLine } from "@/lib/document-extraction/commodity-evidence";
import { matchSnapshot, packingMatchRows, type MatchSource, type CustomsMatch } from "@/lib/document-extraction/customs-matches";

export function CustomsMatchForm({ shipmentId, declaration, invoices, packing, products, history, editable }: {
 shipmentId:string; declaration:MatchSource; invoices:Array<MatchSource&{title:string}>; packing:Array<MatchSource&{title:string}>;
 products:Array<{id:string;sku:string;name:string}>; history:CustomsMatch[]; editable:boolean;
}) {
 const [invoiceId,setInvoice]=useState(""); const [packingId,setPacking]=useState("");
 const invoice=invoices.find(i=>i.id===invoiceId), pack=packing.find(i=>i.id===packingId);
 const record=declaration.extracted_data.customs_record;
 if(!record || typeof record!=="object" || !("kind" in record) || record.kind!=="declaration" || !("items" in record) || !Array.isArray(record.items) || !record.items.every(isCommodityLine))return null;
 const ir=invoice&&isCommodityInvoice(invoice.extracted_data.commodity_invoice)?invoice.extracted_data.commodity_invoice.items:[];
 const pr=pack?packingMatchRows(pack.extracted_data):[];
 return <section className="setup-notice customs-match"><h4>Сопоставить строки ДТ с товарами</h4>
  <p>Если в оригинале нет артикула Nexus, укажите связь вручную. Артикулы в документ не дописываются. Сопоставление не меняет количества, приёмку, финансы или прежние подтверждения.</p>
  {editable&&<form action={saveCustomsMatchAction}>
   <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={declaration.id}/>
   <input type="hidden" name="expected_id" value={history[0]?.id??""}/><input type="hidden" name="line_count" value={record.items.length}/>
   <input type="hidden" name="snapshot" value={invoice&&pack?JSON.stringify(matchSnapshot([declaration,invoice,pack])):""}/>
   <div className="doc-form"><label>Подтверждённый инвойс<select name="invoice_id" required value={invoiceId} onChange={e=>setInvoice(e.target.value)}><option value="">Выберите документ</option>{invoices.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
   <label>Подтверждённый упаковочный лист<select name="packing_id" required value={packingId} onChange={e=>setPacking(e.target.value)}><option value="">Выберите документ</option>{packing.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label></div>
   {invoice&&pack&&<div key={`${invoiceId}:${packingId}`}>
    {record.items.map(row=><fieldset key={row.number}><legend>Строка ДТ {row.number}: {row.description}</legend><p>{row.quantity} {row.unit} · ТН ВЭД {row.hsCode} · {row.amount}</p>
     <div className="doc-form"><label>Товар Nexus<select name={`product_${row.number}`} required defaultValue=""><option value="">Выберите товар</option>{products.map(p=><option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</select></label>
     <label>Строка инвойса<select name={`invoice_${row.number}`} required defaultValue=""><option value="">Выберите строку</option>{ir.map(i=><option key={i.number} value={i.number}>№{i.number} · {i.description} · {i.quantity} {i.unit}</option>)}</select></label>
     <label>Строка упаковочного листа<select name={`packing_${row.number}`} required defaultValue=""><option value="">Выберите строку</option>{pr.map((i,n)=><option key={n} value={n+1}>№{n+1} · {i.description} · {i.quantity} {i.unit}</option>)}</select></label></div>
    </fieldset>)}
    <div className="doc-form"><label className="doc-form-full">Основание сопоставления<textarea name="reason" rows={5} required minLength={10} maxLength={2000} placeholder="Какие названия, партии, веса и количества сверены; какие расхождения остаются"/></label></div>
    <label className="check-label"><input type="checkbox" name="checked" required/> Сверены все выбранные строки с оригиналами</label>
    <PendingSubmitButton className="primary compact" pendingText="Сохраняем связи…">Сохранить сопоставление</PendingSubmitButton>
   </div>}
  </form>}
  {history.length>0&&<details><summary>История сопоставлений: {history.length}</summary>{history.map(m=><div key={m.id}><p>{new Date(m.created_at).toLocaleString("ru-RU",{timeZone:"Asia/Almaty"})} · сотрудник {m.created_by}</p><p>{m.reason}</p><ul>{m.lines.map(l=><li key={l.line}>ДТ №{l.line} → {l.sku} → инвойс №{l.invoice_line} → упаковочный лист №{l.packing_line}</li>)}</ul></div>)}</details>}
 </section>;
}
