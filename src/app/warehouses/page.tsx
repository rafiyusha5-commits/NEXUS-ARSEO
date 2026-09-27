import { AppSidebar } from "@/components/app-sidebar";
import Link from "next/link";
import { requireUser } from "@/lib/auth/access";
import { createLocation, createWarehouse } from "./actions";
const zoneNames:Record<string,string>={receiving:"Приёмка",storage:"Хранение",picking:"Комплектация",quarantine:"Карантин",stickering:"Стикеровка",shipping:"Отгрузка"};
export default async function WarehousesPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
 const {profile,roles,supabase}=await requireUser(); const params=await searchParams;
 const {data:warehouses,error}=await supabase.from("warehouses").select("id, code, name, city, country, address, is_main_hub, is_virtual, status, warehouse_locations(id, code, zone, status)").order("code");
 return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="warehouses"/><section className="workspace admin-workspace">
  <header className="topbar"><div><p className="eyebrow">Фаза 1 · Логистика</p><h1>Склады</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/inventory">Партии и FIFO</Link><span className="page-count">{warehouses?.length??0} складов</span></div></header>
  {params.error&&<div className="login-error admin-message">{params.error}</div>}{params.success&&<div className="login-success admin-message">{params.success}</div>}{error&&<div className="setup-notice">Примените миграцию <strong>202609270002_phase1_reference_data.sql</strong> в Supabase.</div>}
  <div className="reference-two-column">
   <section className="panel admin-section"><p className="eyebrow">Новый склад</p><h2>Добавить склад</h2><form action={createWarehouse} className="stacked-form"><label>Код<input name="code" required placeholder="KAR"/></label><label>Название<input name="name" required/></label><label>Город<input name="city"/></label><label>Страна<input name="country" maxLength={2} placeholder="KZ"/></label><label>Адрес<input name="address"/></label><label className="check-label"><input type="checkbox" name="is_main_hub"/> Основной хаб</label><label className="check-label"><input type="checkbox" name="is_virtual"/> Виртуальный склад</label><button className="primary" disabled={Boolean(error)}>Добавить</button></form></section>
   <section className="panel admin-section"><p className="eyebrow">Зонирование</p><h2>Добавить зону</h2><form action={createLocation} className="stacked-form"><label>Склад<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите</option>{(warehouses??[]).filter(w=>!w.is_virtual).map(w=><option value={w.id} key={w.id}>{w.code} · {w.name.ru}</option>)}</select></label><label>Код зоны<input name="code" required placeholder="REC-01"/></label><label>Назначение<select name="zone" required defaultValue="storage">{Object.entries(zoneNames).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label><button className="primary" disabled={Boolean(error)}>Добавить зону</button></form></section>
  </div>
  <section className="warehouse-grid">{(warehouses??[]).map(w=><article className="panel warehouse-card" key={w.id}><div className="warehouse-code">{w.code}</div><div><h2>{w.name.ru}</h2><p>{w.is_virtual?"Служебный склад":`${w.city}, ${w.country}`}</p></div><div className="tag-list">{w.is_main_hub&&<span className="reference-tag accent">Основной хаб</span>}{w.warehouse_locations.map((l:{id:string;code:string;zone:string})=><span className="reference-tag" key={l.id}>{l.code} · {zoneNames[l.zone]??l.zone}</span>)}</div></article>)}</section>
 </section></main>;
}
