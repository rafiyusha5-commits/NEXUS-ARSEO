import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { businessToday } from "@/lib/dates/business-day";
import { createCustomerOrder } from "./actions";
import { selectAll } from "@/lib/supabase/select-all";
import { HistoricalSaleForm } from "@/components/sales/historical-sale-form";

function name(value:unknown){if(!value||typeof value!=="object")return "—";const row=value as Record<string,unknown>;return String(row.ru??row.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
const statusLabel:Record<string,string>={draft:"Черновик",reserved:"Зарезервирован",confirmed:"Подтверждён",shipped:"Отгружен",cancelled:"Отменён"};

export default async function SalesPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const {profile,roles,supabase}=await requirePageUser();const notices=await searchParams;
  const {data:canBackdate}=await supabase.rpc("can_record_historical_sale");
  // Confirmed orders of this employee that can no longer ship become notifications (idempotent).
  await supabase.rpc("refresh_my_order_notifications");
  const [{data:sales,error},{data:customers},{data:warehouses},{data:currencies},{data:contracts}]=await Promise.all([
    supabase.from("sales").select("id,sale_number,planned_shipment_date,status,created_at,customer:counterparties(short_name,legal_name),warehouse:warehouses(code,name)").order("created_at",{ascending:false}),
    selectAll((from,to)=>supabase.from("counterparties").select("id,short_name,legal_name,min_remaining_shelf_life_pct").contains("roles",["customer"]).eq("status","active").order("legal_name").order("id").range(from,to)),
    supabase.from("warehouses").select("id,code,name").eq("status","active").eq("is_virtual",false).order("code"),
    supabase.from("currencies").select("id,code").eq("is_active",true).order("code"),
    supabase.from("contracts").select("id,number,counterparty:counterparties(short_name,legal_name)").eq("status","active").eq("type","sale").order("number"),
  ]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="sales"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Продажи</p><h1>Заказы покупателей</h1></div><span className="page-count">{sales?.length??0} заказов</span></header>
    <WorkflowHelp section="sales"/>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    {error&&<div className="setup-notice">Не удалось загрузить данные раздела. Обновите страницу. Если ошибка повторится, сообщите администратору название раздела.</div>}
    <details className="panel admin-section create-disclosure"><summary><span><small>Новый заказ</small><strong>Создать заказ покупателя</strong></span><b aria-hidden="true">+</b></summary><div className="create-disclosure-body"><form action={createCustomerOrder} className="reference-form">
      <label>Клиент<select name="customer_id" required defaultValue=""><option value="" disabled>Выберите клиента</option>{customers?.map(c=><option key={c.id} value={c.id}>{c.short_name||c.legal_name}{c.min_remaining_shelf_life_pct!=null?` · ОСГ ≥ ${c.min_remaining_shelf_life_pct}%`:""}</option>)}</select></label>
      <label>Склад отгрузки<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(w=><option key={w.id} value={w.id}>{w.code} · {name(w.name)}</option>)}</select></label>
      <label>Плановая дата отгрузки<input name="planned_shipment_date" type="date" required min={businessToday()}/></label>
      <label>Валюта<select name="currency_id" defaultValue=""><option value="">Не выбрана</option>{currencies?.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select></label>
      <label>Контракт<select name="contract_id" defaultValue=""><option value="">Без контракта</option>{contracts?.map(c=>{const party=one(c.counterparty);return <option key={c.id} value={c.id}>{party?.short_name||party?.legal_name} · № {c.number}</option>;})}</select></label>
      <label>Комментарий<input name="notes"/></label><PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit" disabled={Boolean(error)}>Создать заказ</PendingSubmitButton>
    </form></div></details>
    {canBackdate===true&&<HistoricalSaleForm
      customers={(customers??[]).map(c=>({id:c.id,label:c.short_name||c.legal_name}))}
      warehouses={(warehouses??[]).map(w=>({id:w.id,label:`${w.code} · ${name(w.name)}`}))}
      currencies={(currencies??[]).map(c=>({id:c.id,label:c.code}))}
      contracts={(contracts??[]).map(c=>({id:c.id,label:`${one(c.counterparty)?.short_name||one(c.counterparty)?.legal_name} · № ${c.number}`}))}
    />}
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Реестр</p><h2>Заказы покупателей</h2></div></div><div className="reference-list">
      {sales?.map(s=>{const customer=one(s.customer);const warehouse=one(s.warehouse);return <Link className="reference-row" href={`/sales/${s.id}`} key={s.id}><div><strong>{s.sale_number}</strong><small>{customer?.short_name||customer?.legal_name}</small></div><span className="status">{statusLabel[s.status]??s.status}</span><span className="reference-meta">{warehouse?.code} · {new Intl.DateTimeFormat("ru-RU").format(new Date(s.planned_shipment_date))}</span></Link>;})}
      {!sales?.length&&!error&&<p className="empty-state">Клиентских заказов пока нет.</p>}
    </div></section>
  </section></main>;
}
