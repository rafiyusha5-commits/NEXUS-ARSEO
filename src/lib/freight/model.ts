export type Kind = "carrier" | "driver" | "vehicle" | "driver_documents";
export type Row = Record<string, unknown>;
export type Option = { id: string; label: string; inactive?: boolean };
export type Field = { key: string; label: string; required?: boolean; type?: "text" | "list" | "boolean" | "select"; options?: Option[]; max?: number };
export const kinds: Record<Kind, string> = { carrier: "Перевозчики", driver: "Водители", vehicle: "Машины и прицепы", driver_documents: "Документы водителя" };
export const modes = { purchase: "Импорт", sale: "Продажа", transfer: "Перемещение" };
export function sourceFields(kind: Kind, source: Row | undefined): Row {
  if(!source)return {};
  const values:Row={};
  const copy=(key:string)=>{if(typeof source[key]==="string"&&String(source[key]).trim())values[key]=source[key];};
  if(kind==="driver"){copy("full_name");if(typeof source.phone==="string"&&source.phone.trim())values.phones=[source.phone];}
  if(kind==="vehicle"){copy("plate_number");copy("make");}
  // Names from a document never choose a legal entity, country or protected identity.
  return values;
}
export function fieldValue(kind: Kind, record: Row | null | undefined, key: string): unknown {
  return kind === "carrier" && key === "active" ? record?.directory_active ?? record?.active : record?.[key];
}
export function fields(kind: Kind, companies: Option[], carriers: Option[], documents: Option[] = []): Field[] {
  const active: Field[] = [{key:"active",label:"Работаем",type:"boolean"},{key:"inactive_reason",label:"Причина прекращения работы",max:1000}];
  if(kind==="carrier")return [
    {key:"counterparty_id",label:"Юридическое лицо перевозчика",required:true,type:"select",options:companies},
    {key:"directions",label:"Направления (каждое с новой строки)",type:"list"},
    {key:"transport_types",label:"Типы транспорта (каждый с новой строки)",type:"list"},
    {key:"payment_terms",label:"Условия оплаты",max:1000},{key:"signatory",label:"Подписант",max:200},
    {key:"framework_contract_id",label:"Рамочный договор — документ Nexus",type:"select",options:documents},...active];
  if(kind==="driver")return [
    {key:"full_name",label:"ФИО",required:true,max:200},{key:"phones",label:"Телефоны (каждый с новой строки)",type:"list"},
    {key:"whatsapp",label:"WhatsApp",max:50},{key:"carrier_id",label:"Перевозчик",type:"select",options:carriers},...active];
  if(kind==="driver_documents")return [{key:"iin",label:"ИИН",max:12},{key:"document_requisites",label:"Реквизиты документа водителя",max:1000}];
  return [{key:"carrier_id",label:"Перевозчик",required:true,type:"select",options:carriers},
    {key:"plate_number",label:"Госномер",required:true,max:40},{key:"registration_country",label:"Страна регистрации (KZ, PL, RU…)",required:true,max:2},
    {key:"vehicle_type",label:"Тип транспорта",type:"select",required:true,options:[{id:"truck",label:"Тягач / грузовой автомобиль"},{id:"trailer",label:"Прицеп"},{id:"refrigerator",label:"Рефрижератор"}]},
    {key:"make",label:"Марка",max:100},{key:"body_type",label:"Кузов",max:100},{key:"capacity_kg",label:"Грузоподъёмность, кг"},
    {key:"pallet_capacity",label:"Вместимость, паллет"},{key:"temperature_capability",label:"Температурный режим",max:200},
    {key:"status",label:"Статус",type:"select",required:true,options:[{id:"active",label:"Действует"},{id:"archived",label:"Не используется"}]}];
}
export function display(value: unknown): string {
  if(value==null||value==="")return "Не указано";
  if(typeof value==="boolean")return value?"Да":"Нет";
  if(Array.isArray(value))return value.map(display).join(", ")||"Не указано";
  return String(value);
}
export function directoryValues(kind: Kind, form: FormData): Row {
  const result: Row={};
  for(const field of fields(kind,[],[])){
    const value=String(form.get(field.key)??"").trim();
    result[field.key]=field.type==="boolean"?form.get(field.key)==="on":field.type==="list"?value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):value||null;
  }
  return result;
}
export function tripValues(form: FormData): Row {
  const text=(name:string)=>String(form.get(name)??"").trim()||null;
  const address=(name:string)=>({warehouse_id:text(name+"_warehouse"),address:text(name+"_address"),contact:text(name+"_contact"),confirmed:form.get(name+"_confirmed")==="on"});
  return {carrier_id:text("carrier_id"),driver_id:text("driver_id"),vehicle_id:text("vehicle_id"),trailer_id:text("trailer_id"),pallet_tare_kg:text("pallet_tare_kg"),origin:address("origin"),destination:address("destination")};
}
