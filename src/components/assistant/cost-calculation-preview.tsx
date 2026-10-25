export type CostData = {
 shipment_id:string;shipment_number:string;currency:string;version:number;approved_version:number|null;performer:string;
 goods_total:number;expenses_total:number;landed_total:number;planned_total:number|null;planned_without_rate:number;excluded_count:number;
 item_units:Record<string,string>;
 products:Record<string,{name:string;sku:string}>;
 lines:{shipment_item_id:string;product_id:string;quantity:number;cost_quantity:number;cost_quantity_basis:string;
 goods_amount:number;allocated_expenses:number;landed_amount:number;unit_landed_cost:number;
 goods_rate:number|null;goods_rate_date:string|null;goods_rate_basis:string}[];
};
const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
const basis:Record<string,string>={received:"Принято",shipped:"Отгружено",confirmed:"Подтверждено поставщиком",ordered:"Заказано"};
const rates:Record<string,string>={expense:"Распределённая стоимость товара",same_currency:"Одна валюта",customs_declaration:"Подтверждённая ДТ",calculation:"Предварительный курс без ДТ"};
export function CostCalculationPreview({preview:p}:{preview:CostData}){
 const preliminary=p.lines.some(l=>l.goods_rate_basis==="calculation");
 return <>
  <h4>{p.shipment_number} · новая версия {p.version}</h4>
  <dl className="assistant-values">
   <div><dt>Стоимость товара</dt><dd>{p.goods_total} {p.currency}</dd></div>
   <div><dt>Фактические дополнительные расходы</dt><dd>{p.expenses_total} {p.currency}</dd></div>
   <div><dt>Итоговая себестоимость</dt><dd>{p.landed_total} {p.currency}</dd></div>
   <div><dt>План для сравнения, не в итоге</dt><dd>{p.planned_total ?? (p.planned_without_rate>0 ? "Нет курса" : "Не задан")} {p.planned_total!==null&&p.currency}</dd></div>
   <div><dt>Исполнитель</dt><dd>{p.performer}</dd></div>
  </dl>
  {p.planned_without_rate>0&&<p className="admin-message">Плановых расходов без курса: {p.planned_without_rate}. Сравнение с планом неполное.</p>}
  <h4>Все позиции расчёта</h4>
  <ul>{p.lines.map(l=><li key={l.shipment_item_id}>
   <strong>{p.products[l.product_id]?.name} · {p.products[l.product_id]?.sku}</strong>
   <p>Количество позиции: {l.quantity} {units[p.item_units[l.shipment_item_id]]??p.item_units[l.shipment_item_id]}. База стоимости: {l.cost_quantity} {units[p.item_units[l.shipment_item_id]]??p.item_units[l.shipment_item_id]} ({basis[l.cost_quantity_basis]??l.cost_quantity_basis}).</p>
   <p>Товар: {l.goods_amount}; расходы: {l.allocated_expenses}; итого: {l.landed_amount} {p.currency}.</p>
   <p><strong>За единицу: {l.unit_landed_cost} {p.currency}</strong></p>
   <p>{rates[l.goods_rate_basis]??l.goods_rate_basis}{l.goods_rate!==null&&<> · курс {l.goods_rate}</>}{l.goods_rate_date&&<> · {l.goods_rate_date}</>}</p>
  </li>)}</ul>
  {preliminary&&<p role="note" className="admin-message">Без подтверждённой ДТ расчёт предварительный. Такая версия не может быть утверждена до устранения причины и нового расчёта.</p>}
  <p className="form-help">Исключено позиций с нулевым количеством: {p.excluded_count}. Стоимость товара не учитывается дважды. База закупки отделена от годного остатка; повреждения и недостачи не создают товар.</p>
  <p className="admin-message">Будет создан только черновик версии {p.version}. Автоматического утверждения, оплаты или распределения расходов нет. Стоимость партий и остатки не изменятся.{p.approved_version!==null&&<> Утверждённая версия {p.approved_version} сохраняется.</>}</p>
  <p className="form-help">При изменении исходных данных, прав или версии понадобится новый предпросмотр.</p>
 </>;
}
