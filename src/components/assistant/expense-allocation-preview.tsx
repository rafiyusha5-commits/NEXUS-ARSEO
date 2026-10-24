import { ALLOCATION_METHODS } from "@/lib/agent/expense-allocation";
import { EXPENSE_TYPES } from "@/lib/agent/expenses";
export type ExpenseAllocationData = { expense_id:string;shipment_number:string;expense_type:keyof typeof EXPENSE_TYPES;payee:string|null;amount:string;currency:string;incurred_at:string;status:string;document:string|null;
 method:keyof typeof ALLOCATION_METHODS;target_currency:string;rate:string;rate_date:string|null;rate_source:string|null;total:string;performer:string;excluded_count:number;
 lines:{item_id:string;product:string;sku:string;quantity:string;uom:string;quantity_source:string;basis:string;share:string;amount:string}[];
 previous:{id:string;item_id:string|null;product:string;amount:string;currency:string;method:string}[] };
const sources:Record<string,string>={received:"Принято",shipped:"Отгружено",confirmed:"Подтверждено поставщиком",ordered:"Заказано"};
export function ExpenseAllocationPreview({preview:p}:{preview:ExpenseAllocationData}){
 return <>
  <h4>{p.shipment_number} · {EXPENSE_TYPES[p.expense_type]}</h4>
  <dl className="assistant-values">
   <div><dt>Расход</dt><dd>{p.amount} {p.currency}</dd></div>
   <div><dt>Дата расхода</dt><dd>{p.incurred_at}</dd></div>
   <div><dt>Способ</dt><dd>{ALLOCATION_METHODS[p.method]}</dd></div>
   <div><dt>Курс</dt><dd>{p.rate} · {p.currency} → {p.target_currency}</dd></div>
   <div><dt>Источник курса</dt><dd>{p.rate_date ? `${p.rate_date} · ${p.rate_source === "bank" ? "Банковский" : "Официальный"}` : "Одна валюта, без конвертации"}</dd></div>
   <div><dt>Получатель</dt><dd>{p.payee ?? "Не указан"}</dd></div>
   <div><dt>Документ</dt><dd>{p.document ?? "Без документа"}</dd></div>
   <div><dt>Исполнитель</dt><dd>{p.performer}</dd></div>
  </dl>
  <h4>Новое распределение</h4>
  <ul>{p.lines.map(l=><li key={l.item_id}><strong>{l.product} · {l.sku}</strong>
   <p>{sources[l.quantity_source] ?? l.quantity_source}: {l.quantity} {l.uom}. База: {l.basis}; доля: {l.share}.</p>
   <p>Будет распределено: <strong>{l.amount} {p.target_currency}</strong></p></li>)}</ul>
  <p><strong>Итого: {p.total} {p.target_currency}</strong></p>
  <p className="form-help">Округление до сотых; остаток округления относится на последнюю позицию в штатном порядке. Исключено позиций с нулевым количеством: {p.excluded_count}.</p>
  {p.previous.length>0 ? <><h4>Будет заменено прежнее распределение</h4><ul>{p.previous.map(l=><li key={l.id}>{l.product}: {l.amount} {l.currency} · {ALLOCATION_METHODS[l.method as keyof typeof ALLOCATION_METHODS] ?? l.method}</li>)}</ul><p className="admin-message">Это замена текущих строк, не добавление второго расхода. Старый предпросмотр сохраняется в журнале операции.</p></> : <p>Прежних строк распределения нет.</p>}
  <p className="admin-message">{p.status==="paid"?"Расход уже оплачен: статус и сведения об оплате сохранятся. Новая оплата не создаётся.":"Расход будет распределён. Оплата не создаётся."} Себестоимость автоматически не рассчитывается и не утверждается. Прежнему черновику расчёта может потребоваться пересчёт; утверждённые версии сохраняются.</p>
  {p.expense_type==="goods_cost"&&<p>Стоимость товара не добавляется второй раз как дополнительный расход.</p>}
  <p className="form-help">Сумма исходного расхода и складские остатки не меняются. При изменении источников или прав нужен новый просмотр.</p>
 </>;
}
