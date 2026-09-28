import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { createCustomerOrder } from "./actions";

function name(value:unknown){if(!value||typeof value!=="object")return "—";const row=value as Record<string,unknown>;return String(row.ru??row.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
const statusLabel:Record<string,string>={draft:"Черновик",reserved:"Зарезервирован",confirmed:"Подтверждён",shipped:"Отгружен",cancelled:"Отменён"};

export default async function SalesPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const {profile,roles,supabase}=await requireUser();const notices=await searchParams;
  const [{data:sales,error},{data:customers},{data:warehouses},{data:currencies},{data:contracts}]=await Promise.all([
    supabase.from("sales").select("id,sale_number,planned_shipment_date,status,created_at,customer:counterparties(short_name,legal_name),warehouse:warehouses(code,name)").order("created_at",{ascending:false}),
    supabase.from("counterparties").select("id,short_name,legal_name,min_remaining_shelf_life_pct").contains("roles",["customer"]).eq("status","active").order("legal_name"),
    supabase.from("warehouses").select("id,code,name").eq("status","active").eq("is_virtual",false).order("code"),
    supabase.from("currencies").select("id,code").eq("is_active",true).order("code"),
    supabase.from("contracts").select("id,number,counterparty:counterparties(short_name,legal_name)").eq("status","active").eq("type","sale").order("number"),
  ]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="sales"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Фаза 4 · Продажи и FEFO</p><h1>Клиентские заказы</h1></div><span className="page-count">{sales?.length??0} заказов</span></header>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    {error&&<div className="setup-notice">Примените миграцию <strong>202609272500_customer_orders_fefo.sql</strong> в Supabase.</div>}
    <section className="panel admin-section"><p className="eyebrow">Новый заказ</p><h2>Создать заказ клиента</h2><form action={createCustomerOrder} className="reference-form">
      <label>Клиент<select name="customer_id" required defaultValue=""><option value="" disabled>Выберите клиента</option>{customers?.map(c=><option key={c.id} value={c.id}>{c.short_name||c.legal_name}{c.min_remaining_shelf_life_pct!=null?` · ОСГ ≥ ${c.min_remaining_shelf_life_pct}%`:""}</option>)}</select></label>
      <label>Склад отгрузки<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(w=><option key={w.id} value={w.id}>{w.code} · {name(w.name)}</option>)}</select></label>
      <label>Плановая дата отгрузки<input name="planned_shipment_date" type="date" required min={new Date().toISOString().slice(0,10)}/></label>
      <label>Валюта<select name="currency_id" defaultValue=""><option value="">Не выбрана</option>{currencies?.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select></label>
      <label>Контракт<select name="contract_id" defaultValue=""><option value="">Без контракта</option>{contracts?.map(c=>{const party=one(c.counterparty);return <option key={c.id} value={c.id}>{party?.short_name||party?.legal_name} · № {c.number}</option>;})}</select></label>
      <label>Комментарий<input name="notes"/></label><button className="primary" type="submit" disabled={Boolean(error)}>Создать заказ</button>
    </form></section>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Реестр</p><h2>Заказы клиентов</h2></div></div><div className="reference-list">
      {sales?.map(s=>{const customer=one(s.customer);const warehouse=one(s.warehouse);return <Link className="reference-row" href={`/sales/${s.id}`} key={s.id}><div><strong>{s.sale_number}</strong><small>{customer?.short_name||customer?.legal_name}</small></div><span className="status">{statusLabel[s.status]??s.status}</span><span className="reference-meta">{warehouse?.code} · {new Intl.DateTimeFormat("ru-RU").format(new Date(s.planned_shipment_date))}</span></Link>;})}
      {!sales?.length&&!error&&<p className="empty-state">Клиентских заказов пока нет.</p>}
    </div></section>
  </section></main>;
}
