"use client";
import {useState,useTransition} from "react";
import {saveDirectory,previewTrip,saveTrip} from "./actions";
import {directoryValues,display,fieldValue,fields,modes,tripValues,type Kind,type Option,type Row} from "@/lib/freight/model";

function Choice({name,label,options,required=false,value}: {name:string;label:string;options:Option[];required?:boolean;value?:string}) {
  return <label>{label}<select name={name} defaultValue={value??""} required={required}><option value="">Не выбрано</option>{options.map(o=><option key={o.id} value={o.id} disabled={o.inactive&&o.id!==value}>{o.label}{o.inactive?" · неактивен":""}</option>)}</select></label>;
}
export function DirectoryForm({kind,record,companies,carriers,documents,request,source}: {kind:Kind;record:Row|null;companies:Option[];carriers:Option[];documents:Option[];request:string;source?:Row}) {
  const [review,setReview]=useState<{values:Row;reason:string}|null>(null),[error,setError]=useState(""),[saved,setSaved]=useState<string|null>(null),[pending,start]=useTransition();
  const definitions=fields(kind,companies,carriers,documents);
  const id=typeof record?.id==="string"?record.id:typeof record?.driver_id==="string"?record.driver_id:null;
  if(saved)return <div role="status" className="login-success">Сохранено с историей. <a href={`/freight?kind=${kind}&edit=${saved}`}>Открыть запись</a></div>;
  const show=(key:string,value:unknown)=>definitions.find(f=>f.key===key)?.options?.find(o=>o.id===value)?.label??display(value);
  return <div>{error&&<p role="alert" className="login-error">{error}</p>}
    <form className="freight-form" hidden={!!review} onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);const values=directoryValues(kind,form);if(source)values.source=source;setReview({values,reason:String(form.get("reason")??"")});setError("");}}>
      {definitions.map(f=><div key={f.key}>{f.type==="select"?<Choice name={f.key} label={f.label} options={f.options??[]} required={f.required} value={typeof record?.[f.key]==="string"?record[f.key] as string:undefined}/>:
        f.type==="boolean"?<label className="freight-checkbox"><input name={f.key} type="checkbox" defaultChecked={fieldValue(kind,record,f.key)!==false}/>{f.label}</label>:
        <label>{f.label}{f.type==="list"?<textarea name={f.key} defaultValue={Array.isArray(record?.[f.key])?(record[f.key] as string[]).join("\n"):""} maxLength={4000}/>:
        <input name={f.key} defaultValue={record?.[f.key]==null?"":String(record[f.key])} required={f.required} maxLength={f.max??100} autoComplete="off"/>}</label>}</div>)}
      <label>Причина изменения<input name="reason" required minLength={3} maxLength={1000}/></label>
      <button type="submit">Проверить изменения</button>
    </form>{review&&<section aria-label="Предпросмотр изменений"><h3>Проверьте перед сохранением</h3><div className="freight-table"><table><thead><tr><th>Поле</th><th>Сейчас</th><th>После сохранения</th></tr></thead><tbody>{definitions.map(f=><tr key={f.key}><th>{f.label}</th><td>{show(f.key,fieldValue(kind,record,f.key))}</td><td>{show(f.key,review.values[f.key])}</td></tr>)}</tbody></table></div>
      <p>Причина: {review.reason}</p><p>Совпадение телефона не доказывает, что это один водитель. Прежние рейсы сохранят свои реквизиты.</p>
      <div className="freight-buttons"><button disabled={pending} onClick={()=>start(async()=>{const result=await saveDirectory({kind,request,id,version:Number(record?.directory_version??record?.version??0),...review});if(result.error)setError(result.error);else setSaved(result.id!);})}>{pending?"Сохраняем…":"Подтвердить изменения"}</button><button className="ghost" disabled={pending} onClick={()=>setReview(null)}>Вернуться к полям</button></div>
    </section>}
  </div>;
}

export function Snapshot({value}: {value:Row}) {
  const row=(key:string)=>value[key] as Row|undefined;
  const vehicle=row("vehicle"),trailer=row("trailer"),driver=row("driver"),carrier=row("carrier"),origin=row("origin"),destination=row("destination");
  return <dl className="freight-snapshot"><dt>Операция</dt><dd>{modes[value.mode as keyof typeof modes]??"Не указана"}</dd>
    <dt>Связанные документы</dt><dd>{((value.operations??[]) as Row[]).map(x=>String(x.label)).join(", ")}</dd>
    <dt>Перевозчик</dt><dd>{display(carrier?.name)}</dd><dt>Водитель</dt><dd>{display(driver?.full_name)} · {display(driver?.phones)}</dd>
    <dt>Машина</dt><dd>{display(vehicle?.plate_number)} · {display(vehicle?.registration_country)} · {display(vehicle?.make)}</dd>
    <dt>Прицеп</dt><dd>{display(trailer?.plate_number)}</dd><dt>Погрузка</dt><dd>{display(origin?.address)} · {display(origin?.contact)}</dd>
    <dt>Разгрузка</dt><dd>{display(destination?.address)} · {display(destination?.contact)}</dd>
    <dt>Вес пустой паллеты</dt><dd>{display(value.pallet_tare_kg)} кг</dd></dl>;
}

export function TripForm({mode,operations,carriers,drivers,vehicles,warehouses,request,record}: {mode:keyof typeof modes;operations:Option[];carriers:Option[];drivers:Option[];vehicles:Option[];warehouses:Option[];request:string;record?:Row}) {
  const [review,setReview]=useState<{values:Row;operations:string[];snapshot:Row;digest:string;reason:string}|null>(null),[error,setError]=useState(""),[saved,setSaved]=useState<string|null>(null),[pending,start]=useTransition();
  const previous=record?.snapshot as Row|undefined;
  if(saved)return <div role="status" className="login-success">Рейс сохранён. <a href={`/freight?kind=trips&edit=${saved}`}>Открыть рейс и историю</a></div>;
  return <div>{error&&<p role="alert" className="login-error">{error}</p>}
    <form className="freight-form" hidden={!!review} onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);start(async()=>{setError("");const input={mode,operations:form.getAll("operation").map(String),values:tripValues(form)};const result=await previewTrip(input);if(result.error)setError(result.error);else setReview({...input,...result.preview!,reason:String(form.get("reason")??"")});});}}>
      <fieldset className="freight-wide"><legend>Операции этого рейса</legend>{operations.length?operations.map(o=><label className="freight-checkbox" key={o.id}><input type="checkbox" name="operation" value={o.id} defaultChecked={(previous?.operations as Row[]|undefined)?.some(x=>x.id===o.id)}/>{o.label}</label>):<p>Нет доступных непроведённых операций. Создайте обычную поставку, заказ или черновик перемещения.</p>}</fieldset>
      <Choice name="carrier_id" label="Перевозчик" options={carriers} required value={(previous?.carrier as Row)?.id as string}/>
      <Choice name="driver_id" label="Водитель" options={drivers} required value={(previous?.driver as Row)?.id as string}/>
      <Choice name="vehicle_id" label="Машина" options={vehicles.filter(x=>!x.label.startsWith("Прицеп ·"))} required value={(previous?.vehicle as Row)?.id as string}/>
      <Choice name="trailer_id" label="Прицеп" options={vehicles.filter(x=>x.label.startsWith("Прицеп ·"))} value={(previous?.trailer as Row)?.id as string}/>
      <label>Вес пустой паллеты, кг<input name="pallet_tare_kg" type="number" min="20" max="25" step="0.001" required defaultValue={previous?.pallet_tare_kg==null?"":String(previous.pallet_tare_kg)}/></label>
      {(["origin","destination"] as const).map(key=><fieldset key={key}><legend>{key==="origin"?"Погрузка":"Разгрузка"}</legend><Choice name={key+"_warehouse"} label="Склад Nexus" options={warehouses} value={(previous?.[key] as Row)?.warehouse_id as string}/>
        <label>Либо полный адрес вручную<input name={key+"_address"} maxLength={1000} defaultValue={String((previous?.[key] as Row)?.address??"")}/></label><label>Контакт на месте<input name={key+"_contact"} maxLength={300} defaultValue={String((previous?.[key] as Row)?.contact??"")}/></label>
        <label className="freight-checkbox"><input name={key+"_confirmed"} type="checkbox"/>Ручной адрес проверен</label></fieldset>)}
      <label>Причина сохранения / изменения<input name="reason" required minLength={3} maxLength={1000}/></label>
      <button disabled={pending}>{pending?"Проверяем…":"Предпросмотр рейса"}</button>
    </form>{review&&<section aria-label="Предпросмотр рейса"><h3>Проверьте реквизиты рейса</h3><Snapshot value={review.snapshot}/><p>Причина: {review.reason}</p><p>Сохранение рейса не проводит приёмку, продажу или перемещение и не создаёт расход.</p>
      <div className="freight-buttons"><button disabled={pending} onClick={()=>start(async()=>{const result=await saveTrip({request,id:typeof record?.id==="string"?record.id:null,version:Number(record?.version??0),mode,...review});if(result.error)setError(result.error);else setSaved(result.id!);})}>{pending?"Сохраняем…":"Подтвердить рейс"}</button><button className="ghost" disabled={pending} onClick={()=>setReview(null)}>Вернуться к полям</button></div>
    </section>}
  </div>;
}
