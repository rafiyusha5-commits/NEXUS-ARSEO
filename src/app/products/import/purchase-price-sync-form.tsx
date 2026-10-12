"use client";
import {useState,useTransition} from "react";
import {syncCalculatorPurchasePrices} from "./actions";
import type {PurchasePriceReport} from "@/lib/calculator-import/purchase-prices.ts";
const labels:Record<string,string>={update:"Будет перенесено",unchanged:"Совпадает",missing_price:"Нет цены в источнике",invalid_price:"Некорректная цена",new_product:"Нет карточки товара",archived:"Архивный товар",unit_mismatch:"Другая базовая единица",invalid_currency:"Валюта источника не распознана",manual_conflict:"Цена изменена вручную — требуется проверка"};
export function PurchasePriceSyncForm({currencies}:{currencies:{code:string}[]}) {
 const [currency,setCurrency]=useState("");const [report,setReport]=useState<PurchasePriceReport|null>(null);const [error,setError]=useState("");const [busy,start]=useTransition();
 const run=(mode:"preview"|"apply")=>start(async()=>{
  setError("");try{const result=await syncCalculatorPurchasePrices(currency,mode,report?.snapshot);if(result.ok)setReport(result.report);else{setError(result.message);setReport(null);}}catch{setError("Не удалось подключиться. Повторите проверку цен.");setReport(null);}
 });
 return <section className="panel admin-section">
  <h2>Закупочные цены из калькулятора</h2>
  <p>Перенести «Цена за единицу» из сохранённого калькулятора в карточки товаров. Валюта берётся из «Валюта закупа» каждой строки. Подтвердите резервную валюту для пустых значений; цена должна быть за одну штуку. После применения это правило используется при следующих синхронизациях.</p>
  <label>Валюта для пустых значений источника <select value={currency} disabled={busy} onChange={event=>{setCurrency(event.target.value);setReport(null);setError("");}}><option value="">Выберите валюту</option>{currencies.map(item=><option key={item.code} value={item.code}>{item.code}</option>)}</select></label>
  <p className="form-help">Цена за: 1 штуку. Пустые цены и конфликтующие ручные изменения не перезаписываются.</p>
  <button type="button" className="primary" disabled={busy||!currency} onClick={()=>run("preview")}>{busy?"Обработка…":"Проверить перенос цен"}</button>
  {error&&<p className="login-error">{error}</p>}
  {report&&<div>
   <p>{report.applied?"Перенесено":"К переносу"}: {report.summary.update}; совпадает: {report.summary.unchanged}; требуют внимания: {report.summary.skipped}. Резервная валюта: {report.currency}, за штуку.</p>
   <details><summary>Посмотреть товары и причины пропуска</summary><table><thead><tr><th>Артикул</th><th>Цена сейчас</th><th>Цена калькулятора</th><th>Валюта</th><th>Результат</th></tr></thead><tbody>{report.items.map(item=><tr key={item.sku}><td>{item.sku}</td><td>{item.old_price??"—"}</td><td>{item.price??"—"}</td><td>{item.currency === null ? "Не распознана" : item.currency??report.currency??"—"}</td><td>{labels[item.action]}</td></tr>)}</tbody></table></details>
   {!report.applied&&<button type="button" className="primary" disabled={busy||!report.snapshot} onClick={()=>run("apply")}>Перенести проверенные цены и включить правило</button>}
  </div>}
 </section>;
}