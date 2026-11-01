import { ReceivingItem } from "@/components/shipments/receiving-item";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { receiveShipmentTransport } from "../../actions";

const transportStatus:Record<string,string>={planned:"Запланирован",loading:"На загрузке",in_transit:"В пути",at_customs:"На таможне",arrived:"Прибыл",unloaded:"Разгружен",cancelled:"Отменён"};
const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"авто"};
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
function name(value:unknown){if(!value||typeof value!=="object")return "—";const item=value as Record<string,unknown>;return String(item.ru??item.en??"—");}

export default async function ShipmentReceivingPage({params,searchParams}:{
  params:Promise<{id:string}>;
  searchParams:Promise<{transport?:string;error?:string}>;
}){
  const {id}=await params;
  const query=await searchParams;
  if(!query.transport)redirect(`/shipments/${id}`);
  const {profile,roles,supabase}=await requireUser();
  const permissions=await loadPermissions(supabase,["inventory.receive"] as const);
  const {data:shipment,error}=await supabase.from("shipments").select("id,shipment_number,status,is_locked,destination_warehouse_id,warehouse:warehouses(name,code)").eq("id",id).maybeSingle();
  if(error||!shipment)notFound();
  const [{data:transport},{data:items},{data:locations},{data:receipt}]=await Promise.all([
    supabase.from("shipment_transports").select("id,shipment_id,sequence_no,status,planned_arrival_date,actual_arrival_date,notes").eq("id",query.transport).eq("shipment_id",id).maybeSingle(),
    supabase.from("shipment_items").select("id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,product:products(internal_sku,name,brand)").eq("shipment_id",id).eq("shipment_transport_id",query.transport).order("created_at"),
    supabase.from("warehouse_locations").select("id,code,zone").eq("warehouse_id",shipment.destination_warehouse_id).eq("status","active").order("zone").order("code"),
    supabase.from("shipment_transport_receipts").select("id,received_at,performed_by_name").eq("shipment_transport_id",query.transport).maybeSingle(),
  ]);
  if(!transport)notFound();
  const warehouse=one(shipment.warehouse);
  const canReceive=permissions["inventory.receive"]&&transport.status==="arrived"&&!receipt&&!shipment.is_locked&&!['on_hold','cancelled','closed'].includes(shipment.status);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Приёмка поставки</p><h1>{shipment.shipment_number} · Автомобиль №{transport.sequence_no}</h1></div><div className="topbar-actions"><span className={`status transport-${transport.status}`}>{transportStatus[transport.status]??transport.status}</span><Link className="ghost button-link" href={`/shipments/${shipment.id}`}>К карточке поставки</Link></div></header>
    {query.error&&<div className="login-error admin-message">{query.error}</div>}
    {!permissions["inventory.receive"]&&<div className="login-error admin-message">Нет права на приёмку товара.</div>}
    <section className="shipment-summary-grid receiving-summary">
      <article className="summary-card"><p>Склад</p><strong>{warehouse?.code??"—"}</strong><small>{name(warehouse?.name)}</small></article>
      <article className="summary-card"><p>Позиций</p><strong>{items?.length??0}</strong><small>Все позиции нужно принять одним запуском</small></article>
      <article className="summary-card"><p>Прибытие</p><strong>{transport.actual_arrival_date?new Intl.DateTimeFormat("ru-RU").format(new Date(transport.actual_arrival_date)):"—"}</strong><small>{transport.notes||"Без примечания"}</small></article>
    </section>
    {receipt&&<section className="panel admin-section"><div className="login-success admin-message">Автомобиль уже принят {new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short"}).format(new Date(receipt.received_at))}. Исполнитель: {receipt.performed_by_name}.</div></section>}
    {!receipt&&transport.status!=="arrived"&&<div className="setup-notice">Сначала в карточке поставки измените статус автомобиля на <strong>«Прибыл»</strong>.</div>}
    {canReceive&&!!items?.length&&<form action={receiveShipmentTransport} className="panel admin-section receiving-form">
      <input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="transport_id" value={transport.id}/>
      <div className="panel-heading"><div><p className="eyebrow">Фактические данные</p><h2>Товары и партии</h2></div><span className="page-count">одна транзакция</span></div>
      <p className="form-help">При недостаче, излишке или повреждении обязательно укажите причину. В остаток попадает только принятое количество.</p>
      <div className="receiving-items">{items.map((item)=>{const product=one(item.product);const expected=Number(item.shipped_quantity??item.confirmed_quantity??item.ordered_quantity);return <ReceivingItem key={item.id} itemId={item.id} expected={expected} unit={units[item.uom]??item.uom} title={`${product?.internal_sku} · ${name(product?.name)}`}/>;})}</div>
      <div className="receiving-footer">
        <label>Зона склада<select name="location_id" defaultValue=""><option value="">Без зоны</option>{locations?.map((location)=><option value={location.id} key={location.id}>{location.code} · {location.zone}</option>)}</select></label>
        <label>Исполнитель<input name="performed_by_name" defaultValue={profile.full_name} required/></label>
        <label className="receiving-notes">Примечание<input name="notes" placeholder="Состояние пломбы, температура, акт…"/></label>
        <button className="primary" type="submit">Завершить приёмку</button>
      </div>
    </form>}
    {!receipt&&canReceive&&!items?.length&&<div className="setup-notice">В этом автомобиле нет распределённых товаров.</div>}
  </section></main>;
}
