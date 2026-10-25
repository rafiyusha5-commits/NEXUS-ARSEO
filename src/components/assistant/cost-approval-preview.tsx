export type CostApprovalData={
 calculation_id:string;shipment_number:string;version:number;currency:string;goods_total:string;expenses_total:string;landed_total:string;calculated_at:string;performer:string;
 previous:{id:string;version:number}[];
 lines:{item_id:string;product:string;sku:string;quantity:string;cost_quantity:string|null;cost_quantity_basis:string|null;uom:string;goods_amount:string;expenses:string;total:string;unit_cost:string;rate:string|null;rate_date:string|null;rate_basis:string|null}[];
 batches:{id:string;batch:string;product:string;old_cost:string|null;old_currency:string|null;old_version:number|null;new_cost:string;new_currency:string}[];
};
const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
const basis:Record<string,string>={received:"Принято",shipped:"Отгружено",confirmed:"Подтверждено поставщиком",ordered:"Заказано"};
const rates:Record<string,string>={expense:"Распределённая стоимость товара",same_currency:"Одна валюта",customs_declaration:"Подтверждённая ДТ"};
export function CostApprovalPreview({preview:p}:{preview:CostApprovalData}){
 return <>
  <h4>{p.shipment_number} · утверждение версии {p.version}</h4>
  <dl className="assistant-values">
   <div><dt>Стоимость товара</dt><dd>{p.goods_total} {p.currency}</dd></div>
   <div><dt>Фактические дополнительные расходы</dt><dd>{p.expenses_total} {p.currency}</dd></div>
   <div><dt>Итоговая себестоимость</dt><dd>{p.landed_total} {p.currency}</dd></div>
   <div><dt>Расчёт создан</dt><dd>{p.calculated_at}</dd></div>
   <div><dt>Утверждает</dt><dd>{p.performer}</dd></div>
  </dl>
  <h4>Сохранённые позиции версии</h4>
  <ul>{p.lines.map(l=><li key={l.item_id}><strong>{l.product} · {l.sku}</strong>
   <p>Количество: {l.quantity} {units[l.uom]??l.uom}. База стоимости: {l.cost_quantity??"не сохранена"} {units[l.uom]??l.uom}{l.cost_quantity_basis&&<> ({basis[l.cost_quantity_basis]??l.cost_quantity_basis})</>}.</p>
   <p>Товар: {l.goods_amount}; расходы: {l.expenses}; итог: {l.total} {p.currency}. За единицу: {l.unit_cost} {p.currency}.</p>
   <p>{l.rate_basis?(rates[l.rate_basis]??l.rate_basis):"Основание курса не сохранено"}{l.rate!==null&&<> · курс {l.rate}</>}{l.rate_date&&<> · {l.rate_date}</>}</p>
  </li>)}</ul>
  <h4>Изменение стоимости партий</h4>
  {p.batches.length ? <ul>{p.batches.map(b=><li key={b.id}><strong>{b.batch} · {b.product}</strong>
   <p>Было: {b.old_cost===null?"не задано":b.old_cost+" "+(b.old_currency??"валюта не задана")}{b.old_version!==null&&<> · версия {b.old_version}</>}.</p>
   <p>Станет: <strong>{b.new_cost} {b.new_currency}</strong> за единицу · версия {p.version}.</p>
  </li>)}</ul> : <p className="admin-message">Связанных партий пока нет. Будет утверждена версия без изменения партий.</p>}
  <p className="admin-message">{p.previous.length ? <>Прежние утверждённые версии: {p.previous.map(v=>v.version).join(", ")}. Их статус станет «Заменена», записи сохранятся.</> : "Прежней утверждённой версии нет."}</p>
  <p className="admin-message">Версия {p.version} станет утверждённой, показанная стоимость единицы будет записана только в перечисленные партии. Новый расчёт не создаётся. Оплата и распределение расходов не выполняются; физические остатки не меняются.</p>
  <p className="form-help">Изменение версии, исходных данных, партий или прав потребует нового просмотра. Текст в чате не заменяет подтверждение кнопкой.</p>
 </>;
}
