import Link from "next/link";
import { buildShipmentDocumentReadiness } from "@/lib/templates/readiness";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { ShipmentDocumentsPanel } from "@/components/documents/shipment-documents-panel";
import { ShipmentTransportsPanel } from "@/components/shipments/shipment-transports-panel";
import { ShipmentActualDatesPanel } from "@/components/shipments/shipment-actual-dates-panel";
import { ShipmentDriveFolderPanel } from "@/components/documents/shipment-drive-folder-panel";
import { ShipmentSourceDocumentsPanel } from "@/components/documents/shipment-source-documents-panel";
import { ShipmentDocumentReadiness } from "@/components/documents/shipment-document-readiness";
import { ShipmentDocumentCheckPanel } from "@/components/documents/shipment-document-check-panel";
import { LogistShipmentPanel } from "@/components/logist/logist-shipment-panel";
import { OperationTabs } from "@/components/operation-tabs";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { buildShipmentLoadSummary, sumShipmentLoadLines } from "@/lib/shipments/load-summary";
import { loadGenerationPreview } from "@/lib/templates/generation-service";
import { selectAll } from "@/lib/supabase/select-all";
import {
  addShipmentItem,
  allocateShipmentItem,
  changeShipmentOperationalState,
  changeStageStatus,
  deleteShipmentItem,
  reopenShipment,
  updateShipmentItem,
} from "../actions";

const shipmentStatus:Record<string,string>={planning:"Планирование",in_production:"У производителя",preparing_transport:"Подготовка перевозки",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Реализация",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
const stageStatus:Record<string,string>={pending:"Ожидает",in_progress:"В работе",blocked:"Заблокирован",completed:"Завершён",skipped:"Пропущен",not_applicable:"Не требуется"};
const expenseType:Record<string,string>={goods_cost:"Стоимость товара",transport:"Перевозка",logistics:"Логистика",broker_fee:"Брокер",customs_duty:"Пошлина",tax:"НДС",stickering:"Стикеровка",marking:"Маркировка",bank_fee:"Банк",promo:"Промо",return:"Возврат",other:"Прочее"};
function name(value:unknown){if(!value||typeof value!=="object")return "—";const v=value as Record<string,unknown>;return String(v.ru??v.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
const loadNumber=(value:number|null,maximumFractionDigits=3)=>value===null?"—":value.toLocaleString("ru-RU",{maximumFractionDigits});
const uomLabel:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"маш."};

export default async function ShipmentPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{error?:string;success?:string;source_error?:string;source_success?:string;check_error?:string;check_success?:string;tab?:string}>}){
  const {id}=await params; const notices=await searchParams; const {profile,roles,supabase}=await requireUser();
  const permissions=await loadPermissions(supabase,["inventory.receive","templates.generate","documents.create","finance.view","prices.purchase.view","shipments.reopen"] as const);
  const [{data:shipment,error},{data:runs},{data:products},{data:items},{data:transports},{data:receipts},{data:expenses},{data:stageHistory}]=await Promise.all([
    supabase.from("shipments").select("id,shipment_number,project_code,type,status,hold_reason,cancel_reason,is_locked,closed_at,closer:profiles!shipments_closed_by_fkey(full_name),planned_ready_date,planned_arrival_date,created_at,supplier_id,customer_id,supplier:counterparties!shipments_supplier_id_fkey(legal_name,short_name),customer:counterparties!shipments_customer_id_fkey(legal_name,short_name),route:routes(name),warehouse:warehouses(name),currency:currencies(id,code),responsible:profiles!shipments_responsible_user_id_fkey(full_name)").eq("id",id).maybeSingle(),
    supabase.from("shipment_stage_runs").select("id,status,is_required,status_reason,started_at,completed_at,performed_by_name,shipment_transport_id,stage:shipment_stages(code,name,sequence_order,requirement,status_category,scope),transport:shipment_transports(sequence_no)").eq("shipment_id",id).order("created_at"),
    selectAll((from,to)=>supabase.from("products").select("id,internal_sku,name,brand,product_suppliers(supplier_id,status)").eq("status","active").order("internal_sku").order("id").range(from,to)),
    supabase.from("shipment_items").select("id,product_id,shipment_transport_id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,product:products(id,internal_sku,name,brand),transport:shipment_transports(sequence_no)").eq("shipment_id",id).order("created_at"),
    supabase.from("shipment_transports").select("id,sequence_no,status,planned_loading_date,planned_arrival_date,temperature_setpoint,notes,driver_name,driver_phone,driver_document,vehicle_plate,vehicle_make,trailer_plate,trailer_make,carrier_name").eq("shipment_id",id).order("sequence_no"),
    supabase.from("shipment_transport_receipts").select("shipment_transport_id").eq("shipment_id",id),
    supabase.from("expenses").select("id,expense_type,amount,incurred_at,is_planned,status,currency:currencies(code),payee:counterparties!expenses_payee_counterparty_id_fkey(short_name,legal_name)").eq("shipment_id",id).order("incurred_at",{ascending:false}),
    supabase.from("shipment_stage_history").select("id,from_status,to_status,performed_by_name,reason,created_at,run:shipment_stage_runs(stage:shipment_stages(name),transport:shipment_transports(sequence_no)),user:profiles!shipment_stage_history_changed_by_fkey(full_name)").eq("shipment_id",id).order("created_at",{ascending:false}),
  ]);
  if(error||!shipment)notFound();
  const {data:itemPrices}=permissions["prices.purchase.view"]?await supabase.rpc("my_shipment_item_purchase_prices",{p_shipment_id:id}):{data:[]};
  const priceByItem=new Map<string,number|string|null>((itemPrices??[]).map((row:{item_id:string;unit_price:number|string|null})=>[row.item_id,row.unit_price]));
  const visibleItems=(items??[]).map(item=>({...item,unit_price:priceByItem.get(item.id)??null}));
  const loadProductIds=[...new Set(visibleItems.map(item=>item.product_id))];
  const {data:loadPackaging}=loadProductIds.length?await supabase.from("product_packaging").select("product_id,uom,units_per_parent,gross_weight_kg,net_weight_kg").in("product_id",loadProductIds):{data:[]};
  const loadSummary=buildShipmentLoadSummary(visibleItems as Array<Record<string,unknown>>,(loadPackaging??[]) as Array<Record<string,unknown>>);
  const itemById=new Map(visibleItems.map(item=>[item.id,item]));
  const unallocatedLoadLines=loadSummary.lines.filter(line=>!line.transportId);
  const loadGroups=[...(transports??[]).map(transport=>({id:transport.id,label:`Автомобиль №${transport.sequence_no}`,lines:loadSummary.lines.filter(line=>line.transportId===transport.id)})),...(unallocatedLoadLines.length?[{id:"unallocated",label:"Не распределено",lines:unallocatedLoadLines}]:[])].filter(group=>group.lines.length>0);
  const availableProducts=(products??[]).filter((product)=>shipment.type!=="import"||product.product_suppliers?.some((link)=>link.supplier_id===shipment.supplier_id&&link.status==="active"));
  const supplier=one(shipment.supplier); const customer=one(shipment.customer); const route=one(shipment.route);
  const warehouse=one(shipment.warehouse); const currency=one(shipment.currency); const responsible=one(shipment.responsible);
  const canEdit=!shipment.is_locked&&!['on_hold','cancelled','closed'].includes(shipment.status);
  const receivedTransports=new Set((receipts??[]).map((receipt)=>receipt.shipment_transport_id));
  const {data:templates}=permissions["templates.generate"]&&permissions["documents.create"]?await supabase.from("document_templates").select("id,name,flow_direction,counterparty_id,type:document_types(name_ru),current:document_template_versions(mime_type,is_current)").eq("status","approved").eq("is_active",true).eq("current.is_current",true).order("name"):{data:[]};
  const generationTemplates=(templates??[]).filter(template=>{const current=one(template.current)?.mime_type;const partyMatches=!template.counterparty_id||(template.flow_direction==="input"?template.counterparty_id===shipment.supplier_id:template.counterparty_id===shipment.customer_id);return partyMatches&&["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(String(current));});
  let generationPreview:Awaited<ReturnType<typeof loadGenerationPreview>>|null=null;
  if(generationTemplates.length){try{generationPreview=await loadGenerationPreview(supabase,generationTemplates[0].id,id,false);}catch{generationPreview=null;}}
  const documentReadiness=generationPreview?buildShipmentDocumentReadiness(generationPreview.data,generationPreview.confirmedSourceFields):null;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Поставка · {shipment.type}</p><h1>{shipment.shipment_number}</h1></div><div className="topbar-actions"><span className={`status shipment-${shipment.status}`}>{shipmentStatus[shipment.status]??shipment.status}</span><Link className="ghost button-link" href={`/shipments/${shipment.id}/report`}>Отчёт</Link><Link className="ghost button-link" href={`/tasks?view=all&shipment=${shipment.id}`}>Задачи поставки</Link><Link className="ghost button-link" href="/shipments">К реестру</Link></div></header>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    {shipment.status==="on_hold"&&shipment.hold_reason&&<div className="setup-notice"><strong>Поставка приостановлена:</strong> {shipment.hold_reason}</div>}
    {shipment.status==="closed"&&<section className="setup-notice shipment-closed-notice"><div><strong>Поставка закрыта</strong>{shipment.closed_at?` ${new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Qyzylorda"}).format(new Date(shipment.closed_at))}`:""}{one(shipment.closer)?.full_name?` · ${one(shipment.closer)?.full_name}`:""}. Изменения позиций, автомобилей и этапов недоступны.</div>{permissions["shipments.reopen"]&&<form action={reopenShipment} className="inline-item-form"><input type="hidden" name="shipment_id" value={shipment.id}/><input name="reason" required maxLength={500} placeholder="Причина повторного открытия" aria-label="Причина повторного открытия"/><button className="ghost compact" type="submit">Открыть повторно</button></form>}</section>}
    {shipment.status==="cancelled"&&shipment.cancel_reason&&<div className="login-error admin-message"><strong>Поставка отменена:</strong> {shipment.cancel_reason}</div>}
    <OperationTabs activeTab={notices.tab} defaultTab="main" tabs={[
      {id:"main",label:"Основное"},
      {id:"items",label:"Товары",badge:visibleItems.length},
      {id:"load",label:"Загрузка",badge:loadSummary.warnings.length||undefined},
      {id:"delivery",label:"Доставка",badge:transports?.length??0},
      {id:"documents",label:"Документы"},
      {id:"expenses",label:"Расходы",badge:expenses?.length??0},
      {id:"stages",label:"Этапы",badge:`${runs?.filter(run=>run.status==="completed").length??0}/${runs?.length??0}`},
      {id:"history",label:"История",badge:stageHistory?.length??0},
    ]}>
    <>
    {!shipment.is_locked&&shipment.status!=="closed"&&shipment.status!=="cancelled"&&<section className="shipment-state-bar">
      {shipment.status==="on_hold"?<form action={changeShipmentOperationalState}><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="operation" value="resume"/><button className="primary compact" type="submit">Возобновить поставку</button></form>:<form action={changeShipmentOperationalState}><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="operation" value="hold"/><input name="reason" required placeholder="Причина приостановки"/><button className="ghost compact" type="submit">Приостановить</button></form>}
      <form action={changeShipmentOperationalState}><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="operation" value="cancel"/><input name="reason" required placeholder="Причина отмены"/><button className="danger-button compact" type="submit">Отменить поставку</button></form>
    </section>}
    <section className="shipment-summary-grid">
      <article className="summary-card"><p>Проект</p><strong>{shipment.project_code||"—"}</strong><small>{supplier?.short_name||supplier?.legal_name||customer?.short_name||customer?.legal_name||"Контрагент не указан"}</small></article>
      <article className="summary-card"><p>Маршрут</p><strong>{name(route?.name)}</strong><small>Склад: {name(warehouse?.name)}</small></article>
      <article className="summary-card"><p>Ответственный</p><strong>{responsible?.full_name||"—"}</strong><small>Валюта: {currency?.code||"—"}</small></article>
      <article className="summary-card"><p>Плановое прибытие</p><strong>{shipment.planned_arrival_date?new Intl.DateTimeFormat("ru-RU").format(new Date(shipment.planned_arrival_date)):"—"}</strong><small>Готовность: {shipment.planned_ready_date?new Intl.DateTimeFormat("ru-RU").format(new Date(shipment.planned_ready_date)):"—"}</small></article>
    </section>
    <LogistShipmentPanel shipmentId={shipment.id}/>
    </>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Заказ поставщику</p><h2>Позиции</h2></div><span className="page-count">{visibleItems.length}</span></div>
        {canEdit&&<form action={addShipmentItem} className="shipment-subform"><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="currency_id" value={currency?.id??""}/>
          <label>Товар<select name="product_id" required defaultValue=""><option value="" disabled>Выберите товар поставщика</option>{availableProducts.map((product)=><option value={product.id} key={product.id}>{product.internal_sku} · {name(product.name)}</option>)}</select></label>
          <label>Количество<input name="ordered_quantity" type="number" min="0.001" step="0.001" required/></label><label>Ед. изм.<select name="uom" defaultValue="piece"><option value="piece">Штуки</option><option value="box">Коробки</option><option value="pallet">Паллеты</option></select></label>{permissions["prices.purchase.view"]&&<label>Закупочная цена за единицу<input name="unit_price" type="number" min="0" step="0.0001"/></label>}<button className="primary" type="submit">Добавить</button>
        </form>}{canEdit&&shipment.type==="import"&&!availableProducts.length&&<p className="form-help">У этого поставщика нет активных товаров. Сначала привяжите товары в карточке поставщика или товара.</p>}
        <div className="shipment-item-list">{visibleItems.map((item)=>{const product=one(item.product);const transport=one(item.transport);const received=item.received_quantity!=null;return <article className="shipment-item-card" key={item.id}>
          <div className="shipment-item-heading"><div><strong>{name(product?.name)}</strong><small>{product?.internal_sku} · {product?.brand||"Без бренда"}</small></div><span className={transport?"allocation-badge allocated":"allocation-badge"}>{transport?`Автомобиль №${transport.sequence_no}`:"Не распределено"}{received?` · принято ${Number(item.received_quantity).toLocaleString("ru-RU")}`:""}</span></div>
          {canEdit&&received&&<div className="shipment-item-actions">
            {permissions["prices.purchase.view"]&&<form action={updateShipmentItem} className="inline-item-form"><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="item_id" value={item.id}/><input type="hidden" name="quantity" value={Number(item.ordered_quantity)}/><label>Закупочная цена<input name="unit_price" type="number" min="0" step="0.0001" defaultValue={item.unit_price??""}/></label><button className="ghost compact" type="submit">Обновить цену</button></form>}
            <p className="form-help">Позиция принята на склад: количество, автомобиль и удаление больше не меняются.</p>
          </div>}
          {canEdit&&!received&&<div className="shipment-item-actions">
            <form action={updateShipmentItem} className="inline-item-form"><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="item_id" value={item.id}/><label>Количество<input name="quantity" type="number" min="0.001" step="0.001" defaultValue={Number(item.ordered_quantity)} required/></label>{permissions["prices.purchase.view"]&&<label>Закупочная цена<input name="unit_price" type="number" min="0" step="0.0001" defaultValue={item.unit_price??""}/></label>}<button className="ghost compact" type="submit">Обновить</button></form>
            {!!transports?.length&&<form action={allocateShipmentItem} className="inline-item-form allocation-form"><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="item_id" value={item.id}/><label>Распределить<select name="transport_id" required defaultValue=""><option value="" disabled>Выберите автомобиль</option>{transports.filter((option)=>option.id!==item.shipment_transport_id&&option.status!=="cancelled"&&option.status!=="unloaded").map((option)=><option value={option.id} key={option.id}>Автомобиль №{option.sequence_no}</option>)}</select></label><label>Количество<input name="quantity" type="number" min="0.001" max={Number(item.ordered_quantity)} step="0.001" defaultValue={Number(item.ordered_quantity)} required/></label><button className="primary compact" type="submit">Распределить</button></form>}
            <form action={deleteShipmentItem}><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="item_id" value={item.id}/><button className="text-danger" type="submit">Удалить</button></form>
          </div>}
        </article>;})}{!visibleItems.length&&<div className="empty-state">Позиции ещё не добавлены.</div>}</div>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Расчёт по данным товаров</p><h2>Загрузка поставки</h2></div><span className="page-count">{visibleItems.length} позиций</span></div>
        <div className="load-summary-grid">
          <article className="summary-card"><p>Вес нетто</p><strong>{loadNumber(loadSummary.netWeightKg)} кг</strong><small>сумма по всем позициям</small></article>
          <article className="summary-card"><p>Вес брутто</p><strong>{loadNumber(loadSummary.grossWeightKg)} кг</strong><small>сумма по всем позициям</small></article>
          <article className="summary-card"><p>Штуки</p><strong>{loadNumber(loadSummary.pieces)}</strong><small>базовых единиц товара</small></article>
          <article className="summary-card"><p>Короба</p><strong>{loadNumber(loadSummary.boxes)}</strong><small>расчёт по упаковке</small></article>
          <article className="summary-card"><p>Паллеты</p><strong>{loadNumber(loadSummary.pallets)}</strong><small>расчёт по упаковке</small></article>
        </div>
        <div className="import-table-wrap"><table className="import-table"><thead><tr><th>Автомобиль</th><th>Товар</th><th>Внесено</th><th>Штук</th><th>Коробов</th><th>Паллет</th><th>Нетто, кг</th><th>Брутто, кг</th></tr></thead><tbody>{loadSummary.lines.map(line=>{const item=itemById.get(line.itemId);const product=one(item?.product);const transport=one(item?.transport);return <tr className={line.warnings.length?"has-error":""} key={line.itemId}><td>{transport?`№${transport.sequence_no}`:"Не распределено"}</td><td><strong>{product?.internal_sku}</strong><br/><small>{name(product?.name)}</small>{line.warnings.length>0&&<span className="load-warning-text">{line.warnings.join(" · ")}</span>}</td><td>{loadNumber(line.quantity)} {uomLabel[line.uom]??line.uom}</td><td>{loadNumber(line.pieces)}</td><td>{loadNumber(line.boxes)}</td><td>{loadNumber(line.pallets)}</td><td>{loadNumber(line.netWeightKg)}</td><td>{loadNumber(line.grossWeightKg)}</td></tr>;})}</tbody></table></div>
        {loadGroups.length>0&&<div className="load-vehicle-list">{loadGroups.map(group=>{const total=sumShipmentLoadLines(group.lines);return <article key={group.id}><strong>{group.label}</strong><span>{loadNumber(total.pieces)} шт.</span><span>{loadNumber(total.boxes)} кор.</span><span>{loadNumber(total.pallets)} пал.</span><span>нетто {loadNumber(total.netWeightKg)} кг</span><span>брутто {loadNumber(total.grossWeightKg)} кг</span></article>;})}</div>}
        {!visibleItems.length&&<div className="empty-state">Добавьте товары, чтобы увидеть расчёт загрузки.</div>}
        {loadSummary.warnings.length>0&&<div className="setup-notice"><strong>Есть неполные данные:</strong> проверьте выделенные позиции и заполните упаковку в карточках товаров.</div>}
        <p className="form-help">Эти же количества и веса используются при формировании CMR, ТТН, упаковочного листа и экспортного Excel. Контроль превышения грузоподъёмности включится после добавления допустимого веса в карточку автомобиля.</p>
      </section>
      <ShipmentTransportsPanel shipmentId={shipment.id} transports={transports??[]} receivedIds={[...receivedTransports]} canEdit={canEdit} canReceive={!!permissions["inventory.receive"]} loadLines={loadSummary.lines}/>
    <>
    <ShipmentDocumentCheckPanel shipmentId={shipment.id} notice={notices.check_error?{kind:"error",message:notices.check_error}:notices.check_success?{kind:"success",message:notices.check_success}:undefined}/>
    <ShipmentSourceDocumentsPanel readiness={documentReadiness} shipmentId={shipment.id} notice={notices.source_error?{kind:"error",message:notices.source_error}:notices.source_success?{kind:"success",message:notices.source_success}:undefined}/>
    {generationPreview&&<ShipmentDocumentReadiness result={documentReadiness??undefined} shipmentId={shipment.id} data={generationPreview.data} confirmedSourceFields={generationPreview.confirmedSourceFields}/>}
    {permissions["templates.generate"]&&permissions["documents.create"]&&<section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Выходной комплект</p><h2>Сформировать документы перевозки</h2></div><span className="page-count">{generationTemplates.length}</span></div><p className="form-help">Система использует подтверждённые данные из загруженных инвойсов, договор-заявок и транспортных документов.</p><div className="compact-list">{generationTemplates.map(template=>{const type=one(template.type);return <div className="doc-link-row" key={template.id}><div><strong>{template.name}</strong><small>{type?.name_ru??"Документ"} · {template.flow_direction==="input"?"от поставщика":"для покупателя"}</small></div><Link className="primary button-link compact" href={`/templates/${template.id}/generate?shipment=${shipment.id}`}>Сформировать</Link></div>})}{!generationTemplates.length&&<div className="empty-state">Нет подходящих утверждённых DOCX/XLSX-шаблонов для этой поставки.</div>}</div></section>}
    <ShipmentDriveFolderPanel shipmentId={shipment.id}/>
    <ShipmentDocumentsPanel shipmentId={shipment.id}/>
    </>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Финансы поставки</p><h2>Расходы</h2></div><span className="page-count">{expenses?.length??0}</span></div>
      {permissions["finance.view"]?<><div className="compact-list">{expenses?.map(expense=>{const expenseCurrency=one(expense.currency);const payee=one(expense.payee);return <article className="operation-history-row" key={expense.id}><div><strong>{expenseType[expense.expense_type]??expense.expense_type}</strong><small>{expense.incurred_at} · {expense.is_planned?"план":"факт"} · {expense.status}</small></div><strong>{Number(expense.amount).toLocaleString("ru-RU")} {expenseCurrency?.code}</strong><small>{payee?.short_name||payee?.legal_name||"Получатель не указан"}</small></article>})}{!expenses?.length&&<div className="empty-state">Расходов по этой поставке пока нет.</div>}</div><div className="panel-footer-actions"><Link className="primary button-link" href={`/finance?shipment=${shipment.id}`}>Открыть расходы и себестоимость</Link></div></>:<div className="empty-state">Для просмотра расходов требуется право «Финансы: просмотр».</div>}
    </section>
    <>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Процесс RVI</p><h2>Этапы поставки</h2></div><span className="page-count">{runs?.filter((run)=>run.status==="completed").length??0} из {runs?.length??0} завершено</span></div>
      <div className="stage-list">{runs?.sort((a,b)=>(one(a.stage)?.sequence_order??0)-(one(b.stage)?.sequence_order??0)).map((run)=>{const stage=one(run.stage);const stageTransport=one(run.transport);return <article className={`stage-row stage-${run.status}`} key={run.id} id={`stage-${run.id}`}>
        <div className="stage-number">{stage?.sequence_order}</div><div className="stage-copy"><strong>{name(stage?.name)}</strong><small>{stage?.scope==="transport"?(stageTransport?`Автомобиль №${stageTransport.sequence_no}`:"По перевозке"):"По поставке"} · {stage?.requirement==="required"?"обязательный":stage?.requirement==="conditional"?"по условию":"необязательный"}</small>{run.status_reason&&<p>{run.status_reason}</p>}</div>
        <span className={`status stage-badge-${run.status}`}>{stageStatus[run.status]??run.status}</span>
        {canEdit&&<form action={changeStageStatus} className="stage-action"><input type="hidden" name="run_id" value={run.id}/><input type="hidden" name="shipment_id" value={shipment.id}/><select name="status" defaultValue={run.status}><option value="pending">Ожидает</option><option value="in_progress">В работе</option><option value="completed">Завершён</option><option value="blocked">Заблокирован</option><option value="skipped">Пропущен</option><option value="not_applicable">Не требуется</option></select><input name="reason" placeholder="Причина, если требуется"/><button className="ghost compact" type="submit">Сохранить</button></form>}
      </article>;})}</div>
    </section>
    <ShipmentActualDatesPanel shipmentId={shipment.id} shipmentStatus={shipment.status}/>
    </>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Хронология</p><h2>История поставки</h2></div><span className="page-count">{stageHistory?.length??0}</span></div>
      <div className="operation-history-list">
        <article className="operation-history-row"><time>{new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short"}).format(new Date(shipment.created_at))}</time><div><strong>Поставка создана</strong><small>{shipment.shipment_number}</small></div></article>
        {stageHistory?.map(event=>{const run=one(event.run);const historyStage=one(run?.stage);const historyTransport=one(run?.transport);const changedBy=one(event.user);return <article className="operation-history-row" key={event.id}><time>{new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short"}).format(new Date(event.created_at))}</time><div><strong>{name(historyStage?.name)}: {stageStatus[event.from_status]??event.from_status} → {stageStatus[event.to_status]??event.to_status}</strong><small>{historyTransport?`Автомобиль №${historyTransport.sequence_no} · `:""}{event.performed_by_name||changedBy?.full_name||"Сотрудник"}{event.reason?` · ${event.reason}`:""}</small></div></article>})}
        {!stageHistory?.length&&<div className="empty-state">Изменений этапов пока не было.</div>}
      </div>
    </section>
    </OperationTabs>
  </section></main>;
}
