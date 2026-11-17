import {randomUUID} from "node:crypto";
import Link from "next/link";
import {AppSidebar} from "@/components/app-sidebar";
import {DocumentActions} from "@/components/documents/document-actions";
import {loadDocumentActions} from "@/lib/documents/load-actions";
import {requireUser} from "@/lib/auth/access";
import {loadPermissions} from "@/lib/permissions";
import {ruleViolationMessage} from "@/lib/errors/public-message";
import {display,fieldValue,fields,kinds,modes,sourceFields,type Kind,type Row,type Option} from "@/lib/freight/model";
import {DirectoryForm,Snapshot,TripForm} from "./forms";
import "./style.css";

export default async function FreightPage({searchParams}: {searchParams:Promise<Record<string,string|undefined>>}) {
  const {profile,roles,supabase}=await requireUser(),params=await searchParams;
  const kind=params.kind??"carrier",mode=(params.mode&&params.mode in modes?params.mode:"purchase") as keyof typeof modes;
  const grants=await loadPermissions(supabase,["carriers.directory.manage","freight.context.manage","drivers.documents.view"]);
  const permission=new Set(Object.entries(grants).filter(([,allowed])=>allowed).map(([code])=>code));
  // RPC remains authoritative, including active employee status and personal denials.
  const canManage=permission.has("carriers.directory.manage"),canTrip=permission.has("freight.context.manage");
  let error="",rows:Row[]=[],detail:Row|null=null,source:Row|null=null,companies:Option[]=[],carriers:Option[]=[],drivers:Option[]=[],vehicles:Option[]=[],warehouses:Option[]=[],operations:Option[]=[];
  const documentOptions:Option[]=[];
  const sourceTargets:Partial<Record<Kind,Option[]>>={};
  async function rpc(name:string,args:Row):Promise<unknown>{const result=await supabase.rpc(name,args);if(result.error)throw new Error(ruleViolationMessage(result.error,"Раздел недоступен. Проверьте права и состояние базы."));return result.data;}
  async function allRpc(name:string,args:Row):Promise<Row[]>{const result:Row[]=[];let after:string|null=null;for(;;){const page=await rpc(name,{...args,p_after:after}) as Row[];result.push(...page.slice(0,50));if(page.length<=50)return result;after=String(page[49].id);}}
  async function options(table:"counterparties"|"warehouses"):Promise<Option[]>{const out:Option[]=[];for(let from=0;;from+=1000){const q=table==="counterparties"?supabase.from(table).select("id,legal_name,status").contains("roles",["carrier"]).order("id").range(from,from+999):supabase.from(table).select("id,name,status").order("id").range(from,from+999);const r=await q;if(r.error)throw new Error("Не удалось загрузить справочник выбора");for(const row of r.data??[]){const x=row as unknown as Row;out.push({id:String(x.id),label:String(x.legal_name??(x.name as Row)?.ru),inactive:x.status!=="active"});}if((r.data??[]).length<1000)return out;}}
  try{
    if(kind==="trips"){
      rows=await rpc("freight_trips",{p_after:params.after??null}) as Row[];
      if(params.edit)detail=await rpc("freight_trips",{p_id:params.edit}) as Row;
    }else if(kind==="sources"){
      const type=params.source_type==="extraction"?"extraction":"transport";
      rows=await rpc("freight_source_choices",{p_type:type,p_after:params.after??null}) as Row[];
      if(params.source_id)source=await rpc("freight_source_preview",{p_type:type,p_id:params.source_id}) as Row;
      if(source&&canManage)for(const target of ["carrier","driver","vehicle"] as Kind[]){
        sourceTargets[target]=(await allRpc("freight_directory",{p_kind:target,p_query:""})).map(x=>({id:String(x.id),label:display(x.name??x.full_name??x.plate_number)+(x.registration_country?" · "+String(x.registration_country):"")}));
      }
    }else if(kind in kinds){
      if(kind!=="driver_documents")rows=await rpc("freight_directory",{p_kind:kind,p_query:params.q??"",p_after:params.after??null}) as Row[];
      if(params.edit)detail=await rpc("freight_directory_detail",{p_kind:kind,p_id:params.edit}) as Row;
      if(params.source_id)source=await rpc("freight_source_preview",{p_type:params.source_type,p_id:params.source_id}) as Row;
    }else throw new Error("Неизвестный раздел");
    if((canManage&&(kind in kinds))||(canTrip&&kind==="trips")){
      companies=await options("counterparties");
      if(kind==="carrier"){
        for(let from=0;;from+=1000){
          const r=await supabase.from("documents").select("id,title").is("archived_at",null).order("id").range(from,from+999);
          if(r.error)throw new Error("Не удалось загрузить список документов");
          documentOptions.push(...(r.data??[]).map(d=>({id:d.id,label:d.title})));
          if((r.data??[]).length<1000)break;
        }
        const existing=(detail?.record as Row|undefined)?.framework_contract_id;
        if(typeof existing==="string"&&!documentOptions.some(d=>d.id===existing))documentOptions.push({id:existing,label:"Ранее выбранный документ — сейчас недоступен",inactive:true});
      }
      carriers=(await allRpc("freight_directory",{p_kind:"carrier",p_query:""})).map(x=>({id:String(x.id),label:String(x.name),inactive:x.directory_active===false}));
    }
    if(canTrip&&kind==="trips"){
      drivers=(await allRpc("freight_directory",{p_kind:"driver",p_query:""})).map(x=>({id:String(x.id),label:String(x.full_name),inactive:x.active===false}));
      vehicles=(await allRpc("freight_directory",{p_kind:"vehicle",p_query:""})).map(x=>({id:String(x.id),label:(x.vehicle_type==="trailer"?"Прицеп · ":"")+display(x.plate_number)+" · "+display(x.registration_country),inactive:x.status!=="active"||!x.registration_country}));
      warehouses=await options("warehouses");
      operations=(await allRpc("freight_operation_choices",{p_mode:detail?.mode??mode})).map(x=>({id:String(x.id),label:String(x.label)}));
    }
  }catch(e){error=e instanceof Error?e.message:"Не удалось загрузить раздел";}
  const record=detail?.record as Row|undefined;
  const documents=await loadDocumentActions(supabase,[typeof record?.framework_contract_id==="string"?record.framework_contract_id:null,typeof (source?.source as Row)?.document_id==="string"?(source!.source as Row).document_id as string:null]);
  const showRows=rows.slice(0,50),sourceRef=source?{type:(source.source as Row).type,id:(source.source as Row).id,stamp:source.stamp}:undefined;
  const proposed=source?.suggested as Row|undefined;
  const initial=record??(kind==="driver_documents"&&params.edit?{driver_id:params.edit,version:0}:null);
  const formKey=[kind,params.edit,params.source_id,record?.directory_version].join(":");
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="freight"/><section className="workspace admin-workspace freight-workspace">
    <header className="topbar"><div><p className="eyebrow">Логистика</p><h1>Перевозчики и рейсы</h1></div></header>
    <p>Выберите перевозчика, водителя и транспорт. Подтверждение реквизитов сохраняет историю; складские операции выполняются в своих разделах.</p>
    <nav className="freight-tabs" aria-label="Разделы перевозки">{Object.entries(kinds).filter(([key])=>key!=="driver_documents").map(([key,label])=><Link key={key} href={`/freight?kind=${key}`} aria-current={kind===key?"page":undefined}>{label}</Link>)}<Link href="/freight?kind=trips">Рейсы</Link><Link href="/freight?kind=sources">Перенос из источников</Link></nav>
    {error?<p role="alert" className="login-error">{error}</p>:<>
    {kind in kinds&&<>
      <section className="panel admin-section"><h2>{kinds[kind as Kind]}</h2>{kind==="driver_documents"&&<p className="form-help">Срок хранения: если по водителю 12 месяцев нет рейсов и изменений карточки, ИИН и реквизиты документа удаляются автоматически, в том числе из истории изменений. Имя, телефоны и рейсы сохраняются.</p>}{kind!=="driver_documents"&&<form className="freight-search"><input type="hidden" name="kind" value={kind}/><label>Поиск по названию, ФИО, телефону или номеру<input name="q" defaultValue={params.q??""} maxLength={200}/></label><button>Найти</button></form>}
        {showRows.map(row=><article className="freight-row" key={String(row.id)}><strong>{display(row.name??row.full_name??row.plate_number)}</strong><span>{row.active===false||row.directory_active===false||row.status==="archived"?"Не используется":"Действует"}{row.registration_country?" · "+String(row.registration_country):""}</span><Link href={`/freight?kind=${kind}&edit=${row.id}`}>Открыть запись</Link></article>)}
        {!showRows.length&&kind!=="driver_documents"&&<p>Записей по этому запросу нет.</p>}
      </section>
      {(params.edit||params.new==="1"||source)&&<section className="panel admin-section"><h2>{params.edit?"Реквизиты и история":"Новая запись"}</h2>
        {params.saved==="1"&&params.edit&&<div role="status" className="login-success">Сохранено с историей. Прежние значения остались в истории записи.</div>}
        {source&&<p>Источник: {display((source.source as Row).label)}. Поля подставлены как предложение; выберите правильные связи и проверьте каждое значение.</p>}
        {canManage?<DirectoryForm key={formKey} kind={kind as Kind} record={initial} companies={companies} carriers={carriers} documents={documentOptions} request={randomUUID()} source={sourceRef} proposal={sourceFields(kind as Kind,proposed)}/>:<dl>{fields(kind as Kind,companies,carriers,documentOptions).map(f=><div key={f.key}><dt>{f.label}</dt><dd>{display(fieldValue(kind as Kind,record,f.key))}</dd></div>)}</dl>}
        {kind==="driver"&&params.edit&&permission.has("drivers.documents.view")&&<p><Link href={`/freight?kind=driver_documents&edit=${params.edit}`}>Документы водителя — ограниченный доступ</Link></p>}
        {kind==="carrier"&&typeof record?.counterparty_id==="string"&&<p><Link href={`/counterparties/${record.counterparty_id}?tab=contacts`}>Контакты перевозчика</Link>{" · "}<Link href={`/counterparties/${record.counterparty_id}?tab=details`}>Реквизиты юридического лица</Link></p>}
        {typeof record?.framework_contract_id==="string"&&<DocumentActions document={documents[record.framework_contract_id]}/>}
        <h3>История изменений</h3><p>Последние 100 записей; полная история сохраняется в базе.</p>
        {((detail?.history??[]) as Row[]).map(h=><details key={String(h.id)}><summary>{new Date(String(h.created_at)).toLocaleString("ru-RU",{timeZone:"Asia/Almaty"})} · {display(h.reason)}</summary><div className="freight-table"><table><thead><tr><th>Поле</th><th>До</th><th>После</th></tr></thead><tbody>{fields(kind as Kind,companies,carriers,documentOptions).map(f=><tr key={f.key}><th>{f.label}</th><td>{display(fieldValue(kind as Kind,h.before_value as Row,f.key))}</td><td>{display(fieldValue(kind as Kind,h.after_value as Row,f.key))}</td></tr>)}</tbody></table></div></details>)}
      </section>}
      {canManage&&kind!=="driver_documents"&&!params.new&&!params.edit&&!source&&<p><Link className="primary" href={`/freight?kind=${kind}&new=1`}>Добавить запись</Link></p>}
    </>}
    {kind==="trips"&&<>
      <section className="panel admin-section"><h2>Рейсы и согласованные реквизиты</h2>{showRows.map(r=><article className="freight-row" key={String(r.id)}><strong>{modes[r.mode as keyof typeof modes]} · редакция {String(r.version)}</strong><span>{display(((r.snapshot as Row).carrier as Row)?.name)}</span><Link href={`/freight?kind=trips&edit=${r.id}`}>Открыть рейс</Link></article>)}{!rows.length&&<p>Рейсов пока нет.</p>}</section>
      {detail&&<section className="panel admin-section"><h2>Сохранённый рейс</h2><Snapshot value={detail.snapshot as Row}/><h3>Прежние редакции</h3>{detail.history_hidden===true&&<p>Часть прежних редакций недоступна по текущим правам.</p>}{((detail.history??[]) as Row[]).map(h=><details key={String(h.version)}><summary>Редакция {String(h.version)} · {display(h.reason)}</summary><Snapshot value={h.snapshot as Row}/></details>)}</section>}
      {canTrip&&<section className="panel admin-section"><h2>{detail?"Новая редакция рейса":"Подготовить рейс"}</h2>{!detail&&<nav className="freight-tabs">{Object.entries(modes).map(([key,title])=><Link key={key} href={`/freight?kind=trips&mode=${key}`}>{title}</Link>)}</nav>}<p>Текущий вид: {modes[(detail?.mode??mode) as keyof typeof modes]}. Один рейс может содержать несколько операций этого вида.</p>
        <TripForm key={String(detail?.id??mode)} mode={(detail?.mode??mode) as keyof typeof modes} operations={operations} carriers={carriers} drivers={drivers} vehicles={vehicles} warehouses={warehouses} request={randomUUID()} record={detail??undefined}/>
      </section>}
    </>}
    {kind==="sources"&&<section className="panel admin-section"><h2>Предпросмотр переноса</h2><p>Ничего не переносится при открытии. Старые документы и ручные подтверждения сохраняются.</p>
      <nav className="freight-tabs"><Link href="/freight?kind=sources&source_type=transport">Ранее введённые машины</Link><Link href="/freight?kind=sources&source_type=extraction">Подтверждённое распознавание</Link></nav>
      {showRows.map(r=><p key={String(r.id)}><Link href={`/freight?kind=sources&source_type=${params.source_type??"transport"}&source_id=${r.id}`}>{display(r.label)}</Link></p>)}
      {source&&<><h3>{display((source.source as Row).label)}</h3><dl>{Object.entries({"Перевозчик":proposed?.carrier_name,"Водитель":proposed?.full_name,"Телефон":proposed?.phone,"Госномер":proposed?.plate_number,"Марка":proposed?.make,"Прицеп":proposed?.trailer_plate}).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>
        {typeof (source.source as Row).document_id==="string"&&<DocumentActions document={documents[String((source.source as Row).document_id)]}/>}
        {(["carrier","driver","vehicle"] as Kind[]).map(k=><p key={k}><Link href={`/freight?kind=${k}&source_type=${(source.source as Row).type}&source_id=${(source.source as Row).id}${(source.existing as Row)[k]?"&edit="+(source.existing as Row)[k]:""}`}>{(source.existing as Row)[k]?"Открыть перенесённую запись":"Подготовить запись"}: {kinds[k]}</Link></p>)}
        {canManage&&(["carrier","driver","vehicle"] as Kind[]).filter(k=>!(source.existing as Row)[k]&&sourceTargets[k]?.length).map(k=><form key={k} className="freight-search" aria-label={`Сопоставить: ${kinds[k]}`}>
          <input type="hidden" name="kind" value={k}/><input type="hidden" name="source_type" value={String((source.source as Row).type)}/><input type="hidden" name="source_id" value={String((source.source as Row).id)}/>
          <label htmlFor={`source-existing-${k}`}>Уже есть в Nexus: {kinds[k]}</label><select id={`source-existing-${k}`} name="edit" required defaultValue=""><option value="">Выберите существующую запись</option>{sourceTargets[k]!.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select><button>Сравнить с существующей записью</button>
        </form>)}
      </>}
    </section>}
    {rows.length>50&&<Link href={`/freight?${new URLSearchParams({...Object.fromEntries(Object.entries(params).filter((x):x is [string,string]=>x[1]!==undefined)),after:String(rows[49].id)})}`}>Следующие 50</Link>}
    </>}
  </section></main>;
}
