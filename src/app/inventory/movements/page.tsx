import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { OperationTabs } from "@/components/operation-tabs";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { loadPermissions } from "@/lib/permissions";
import { createInventoryOperation } from "./actions";

const operationLabels:Record<string,string>={transfer:"Перемещение",write_off:"Списание",adjustment:"Корректировка"};
const statusLabels:Record<string,string>={draft:"Черновик",posted:"Проведён",cancelled:"Отменён"};
const movementLabels:Record<string,string>={receipt:"Приход",transfer:"Перемещение",issue:"Расход FIFO",write_off:"Списание",adjustment:"Корректировка"};
const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
function localName(value:unknown){if(!value||typeof value!=="object")return "—";const row=value as Record<string,unknown>;return String(row.ru??row.en??"—");}
function date(value:string){return new Intl.DateTimeFormat("ru-RU").format(new Date(value));}
function dateTime(value:string){return new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short"}).format(new Date(value));}

export default async function InventoryMovementsPage({searchParams}:{searchParams:Promise<{tab?:string;error?:string;success?:string}>}){
 const{profile,roles,supabase}=await requireUser();const notices=await searchParams;
 const permissions=await loadPermissions(supabase,["inventory.move","inventory.write_off","inventory.control"] as const);
 const[{data:documents,error:documentError},{data:warehouses},{data:movements,error:movementError}]=await Promise.all([
  supabase.from("inventory_operation_documents").select("id,document_number,operation_type,status,document_date,reference,reason,created_at,posted_at,cancelled_at,from:warehouses!inventory_operation_documents_from_warehouse_id_fkey(code,name),to:warehouses!inventory_operation_documents_to_warehouse_id_fkey(code,name),lines:inventory_operation_lines(id)").order("created_at",{ascending:false}).limit(150),
  supabase.from("warehouses").select("id,code,name,is_virtual,status").eq("status","active").eq("is_virtual",false).order("code"),
  supabase.from("inventory_movements").select("id,inventory_operation_document_id,movement_type,quantity,uom,reference,reason,is_reversal,created_at,document:inventory_operation_documents(document_number),batch:inventory_batches(id,batch_number,product:products(internal_sku,name)),from:warehouses!inventory_movements_from_warehouse_id_fkey(code),to:warehouses!inventory_movements_to_warehouse_id_fkey(code)").order("created_at",{ascending:false}).limit(100),
 ]);
 const canCreate=permissions["inventory.move"]||permissions["inventory.write_off"]||permissions["inventory.control"];
 const setupError=documentError;const counts={draft:0,posted:0,cancelled:0};for(const item of documents??[])if(item.status in counts)counts[item.status as keyof typeof counts]++;
 return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="inventory-movements"/><section className="workspace admin-workspace">
  <header className="topbar"><div><p className="eyebrow">Склад · Операции</p><h1>Складские документы</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/inventory">Остатки и партии</Link><span className="page-count">{documents?.length??0} документов</span></div></header>
  {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
  {setupError&&<div className="setup-notice">Примените миграцию <strong>202609273800_inventory_operation_documents.sql</strong> в Supabase.</div>}
  {canCreate&&!setupError&&<details className="panel admin-section create-disclosure"><summary><span><small>Новый документ</small><strong>Создать складскую операцию</strong></span><b aria-hidden="true">+</b></summary><div className="create-disclosure-body"><form action={createInventoryOperation} className="reference-form">
   <label>Вид операции<select name="operation_type" defaultValue="transfer"><option value="transfer">Перемещение</option><option value="write_off">Списание</option><option value="adjustment">Корректировка</option></select></label>
   <label>Дата документа<input name="document_date" type="date"/></label>
   <label>Склад-отправитель<select name="from_warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(item=><option value={item.id} key={item.id}>{item.code} · {localName(item.name)}</option>)}</select></label>
   <label>Склад-получатель<select name="to_warehouse_id" defaultValue=""><option value="">Только для перемещения</option>{warehouses?.map(item=><option value={item.id} key={item.id}>{item.code} · {localName(item.name)}</option>)}</select></label>
   <label>Основание / документ<input name="reference" placeholder="Накладная, акт, распоряжение"/></label><label>Причина<input name="reason" placeholder="Обязательна для списания"/></label>
   <label>Фактический исполнитель<input name="performed_by_name" placeholder="ФИО работника склада"/></label><button className="primary">Создать черновик</button>
  </form><p className="form-help">Создание черновика не меняет остатки. Товары добавляются в карточке, а изменения выполняются одной транзакцией при проведении.</p></div></details>}
  <OperationTabs ariaLabel="Разделы складских операций" activeTab={notices.tab} defaultTab="documents" tabs={[{id:"documents",label:"Документы",badge:documents?.length??0},{id:"ledger",label:"Проводки",badge:movements?.length??0}]}>
   <section className="panel admin-section"><div className="shipment-summary-grid"><article className="summary-card"><p>Черновики</p><strong>{counts.draft}</strong><small>ещё не меняют остатки</small></article><article className="summary-card"><p>Проведено</p><strong>{counts.posted}</strong><small>остатки обновлены</small></article><article className="summary-card"><p>Отменено</p><strong>{counts.cancelled}</strong><small>движения сторнированы</small></article></div><div className="panel-heading"><div><p className="eyebrow">Журнал документов</p><h2>Складские операции</h2></div></div><div className="reference-list">{documents?.map(item=>{const from=one(item.from);const to=one(item.to);return <Link className="reference-row counterparty-row-link" href={`/inventory/movements/${item.id}`} key={item.id}><div><strong>{item.document_number} · {operationLabels[item.operation_type]??item.operation_type}</strong><small>{from?.code||"—"}{to?` → ${to.code}`:""} · {item.lines?.length??0} строк · {item.reference||item.reason||"Без основания"}</small></div><span className={`status operation-${item.status}`}>{statusLabels[item.status]??item.status}</span><span className="reference-meta">{date(item.document_date)}</span></Link>})}{!documents?.length&&!setupError&&<p className="empty-state">Складских документов пока нет. Создайте первый черновик.</p>}</div></section>
   <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Неизменяемый регистр</p><h2>Проводки по остаткам</h2></div><span className="page-count">до 100 записей</span></div>{movementError?<div className="login-error admin-message">{publicErrorMessage(movementError,"Не удалось загрузить складские проводки.")}</div>:<div className="reference-list">{movements?.map(item=>{const batch=one(item.batch);const product=one(batch?.product);const from=one(item.from);const to=one(item.to);const document=one(item.document);return <Link className="reference-row counterparty-row-link" href={document?`/inventory/movements/${item.inventory_operation_document_id}`:`/inventory/${batch?.id}`} key={item.id}><div><strong>{item.is_reversal?"Сторно · ":""}{movementLabels[item.movement_type]??item.movement_type} · {product?.internal_sku||"Товар"}</strong><small>{batch?.batch_number||"—"} · {from?.code||"—"} → {to?.code||"—"} · {item.reference||item.reason||"Без комментария"}</small></div><span className="reference-tag">{Number(item.quantity).toLocaleString("ru-RU")} {units[item.uom]??item.uom}</span><span className="reference-meta">{document?.document_number||dateTime(item.created_at)}</span></Link>})}{!movements?.length&&<p className="empty-state">Проводок пока нет.</p>}</div>}</section>
  </OperationTabs>
 </section></main>;
}
