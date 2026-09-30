import type { TemplateVariable } from "./rules.ts";

export type GenerationField={key:string;label:string;group:string;loop?:boolean;financial?:boolean};
export const GENERATION_FIELDS:GenerationField[]=[
 {key:"generated_date",label:"Дата формирования",group:"Документ"},{key:"shipment_number",label:"Номер поставки",group:"Поставка"},
 {key:"project_code",label:"Код проекта",group:"Поставка"},{key:"shipment_type",label:"Тип поставки",group:"Поставка"},
 {key:"shipment_status",label:"Статус поставки",group:"Поставка"},{key:"incoterms",label:"Incoterms",group:"Поставка"},
 {key:"planned_ready_date",label:"Плановая готовность",group:"Поставка"},{key:"planned_arrival_date",label:"Плановое прибытие",group:"Поставка"},
 {key:"supplier_name",label:"Поставщик",group:"Контрагенты"},{key:"supplier_tax_id",label:"БИН / налоговый номер поставщика",group:"Контрагенты"},
 {key:"supplier_country",label:"Страна поставщика",group:"Контрагенты"},{key:"customer_name",label:"Покупатель",group:"Контрагенты"},
 {key:"customer_tax_id",label:"БИН / налоговый номер покупателя",group:"Контрагенты"},{key:"customer_country",label:"Страна покупателя",group:"Контрагенты"},
 {key:"route_name",label:"Маршрут",group:"Логистика"},{key:"destination_warehouse",label:"Склад назначения",group:"Логистика"},
 {key:"destination_address",label:"Адрес склада",group:"Логистика"},{key:"responsible_name",label:"Ответственный",group:"Логистика"},
 {key:"currency_code",label:"Валюта поставки",group:"Финансы"},{key:"contract_number",label:"Номер договора",group:"Финансы"},
 {key:"total_lines",label:"Количество товарных строк",group:"Итоги"},{key:"total_quantity",label:"Общее количество",group:"Итоги"},
 {key:"total_amount",label:"Общая сумма",group:"Финансы",financial:true},{key:"total_gross_weight_kg",label:"Общий вес брутто, кг",group:"Итоги"},
 {key:"total_net_weight_kg",label:"Общий вес нетто, кг",group:"Итоги"},{key:"items",label:"Цикл товарных позиций",group:"Таблицы",loop:true},
 {key:"transports",label:"Цикл автомобилей",group:"Таблицы",loop:true},
];
export const ITEM_GENERATION_FIELDS:GenerationField[]=[
 {key:"line_number",label:"Номер строки",group:"Товары"},{key:"product_name",label:"Наименование товара",group:"Товары"},
 {key:"internal_sku",label:"Внутренний артикул",group:"Товары"},{key:"supplier_sku",label:"Артикул поставщика",group:"Товары"},
 {key:"brand",label:"Бренд",group:"Товары"},{key:"hs_code",label:"Код ТН ВЭД",group:"Товары"},{key:"country_of_origin",label:"Страна происхождения",group:"Товары"},
 {key:"gtin",label:"GTIN",group:"Товары"},{key:"unit_barcode",label:"Штрихкод единицы",group:"Товары"},{key:"box_barcode",label:"Штрихкод короба",group:"Товары"},
 {key:"uom",label:"Единица измерения",group:"Товары"},{key:"ordered_quantity",label:"Заказано",group:"Товары"},{key:"confirmed_quantity",label:"Подтверждено",group:"Товары"},
 {key:"shipped_quantity",label:"Отгружено",group:"Товары"},{key:"received_quantity",label:"Принято",group:"Товары"},
 {key:"unit_price",label:"Цена за единицу",group:"Финансы",financial:true},{key:"line_total",label:"Сумма строки",group:"Финансы",financial:true},{key:"currency_code",label:"Валюта строки",group:"Финансы",financial:true},
 {key:"gross_weight_kg",label:"Брутто единицы, кг",group:"Товары"},{key:"net_weight_kg",label:"Нетто единицы, кг",group:"Товары"},{key:"total_gross_weight_kg",label:"Брутто строки, кг",group:"Товары"},{key:"total_net_weight_kg",label:"Нетто строки, кг",group:"Товары"},
];
export const TRANSPORT_GENERATION_FIELDS:GenerationField[]=[
 {key:"sequence_no",label:"Номер автомобиля",group:"Транспорт"},{key:"carrier_name",label:"Перевозчик",group:"Транспорт"},
 {key:"vehicle_plate",label:"Госномер тягача",group:"Транспорт"},{key:"trailer_plate",label:"Госномер прицепа",group:"Транспорт"},
 {key:"driver_name",label:"Водитель",group:"Транспорт"},{key:"driver_phone",label:"Телефон водителя",group:"Транспорт"},
 {key:"temperature_setpoint",label:"Температурный режим",group:"Транспорт"},{key:"planned_loading_date",label:"План загрузки",group:"Транспорт"},
 {key:"actual_loading_date",label:"Факт загрузки",group:"Транспорт"},{key:"planned_arrival_date",label:"План прибытия",group:"Транспорт"},{key:"actual_arrival_date",label:"Факт прибытия",group:"Транспорт"},
];

export type RawGenerationInput={
 shipment:Record<string,unknown>;supplier?:Record<string,unknown>;customer?:Record<string,unknown>;route?:Record<string,unknown>;
 warehouse?:Record<string,unknown>;responsible?:Record<string,unknown>;currency?:Record<string,unknown>;contract?:Record<string,unknown>;
 items:Array<Record<string,unknown>>;products:Map<string,Record<string,unknown>>;identifiers:Array<Record<string,unknown>>;
 packaging:Array<Record<string,unknown>>;transports:Array<Record<string,unknown>>;includePrices:boolean;now?:Date;
};

const text=(value:unknown)=>value===null||value===undefined?"":String(value);
const object=(value:unknown)=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const localized=(value:unknown)=>{const row=object(value);return text(row.ru||row.en||row.kk);};
const number=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:0;};
const optionalNumber=(value:unknown)=>value===null||value===undefined||value===""?"":formatted(number(value));
const formatted=(value:number,scale=3)=>value.toLocaleString("ru-RU",{maximumFractionDigits:scale,useGrouping:false});
const date=(value:unknown)=>{if(!value)return"";const parsed=new Date(String(value).length===10?`${value}T00:00:00Z`:String(value));return Number.isNaN(parsed.valueOf())?text(value):new Intl.DateTimeFormat("ru-RU",{timeZone:"Asia/Qyzylorda"}).format(parsed);};
const partyName=(party?:Record<string,unknown>)=>text(party?.short_name||party?.legal_name);

export function buildShipmentGenerationData(input:RawGenerationInput){
 const s=input.shipment;const idByProduct=new Map<string,Record<string,string>>();
 for(const id of input.identifiers){const productId=text(id.product_id);const row=idByProduct.get(productId)??{};const type=text(id.identifier_type);if(!row[type])row[type]=text(id.value);idByProduct.set(productId,row);}
 const packageByProduct=new Map<string,Record<string,unknown>>();for(const pack of input.packaging)packageByProduct.set(`${text(pack.product_id)}:${text(pack.uom)}`,pack);
 let totalQuantity=0,totalAmount=0,totalGross=0,totalNet=0;
 const items=input.items.map((item,index)=>{const product=input.products.get(text(item.product_id))??{};const ids=idByProduct.get(text(item.product_id))??{};const pack=packageByProduct.get(`${text(item.product_id)}:${text(item.uom)}`)??{};const qty=number(item.ordered_quantity);const price=input.includePrices?number(item.unit_price):0;const gross=number(pack.gross_weight_kg);const net=number(pack.net_weight_kg);totalQuantity+=qty;totalAmount+=qty*price;totalGross+=qty*gross;totalNet+=qty*net;return{
  line_number:index+1,product_name:localized(product.name),internal_sku:text(product.internal_sku),brand:text(product.brand),hs_code:text(product.hs_code),country_of_origin:text(product.country_of_origin),
  supplier_sku:ids.supplier_sku??"",gtin:ids.gtin??"",unit_barcode:ids.unit_barcode??"",box_barcode:ids.box_barcode??"",uom:text(item.uom),ordered_quantity:formatted(qty),confirmed_quantity:optionalNumber(item.confirmed_quantity),shipped_quantity:optionalNumber(item.shipped_quantity),received_quantity:optionalNumber(item.received_quantity),
  unit_price:input.includePrices&&item.unit_price!==null?formatted(price,4):"",line_total:input.includePrices&&item.unit_price!==null?formatted(qty*price,2):"",currency_code:input.includePrices?text(item.currency_code||input.currency?.code):"",
  gross_weight_kg:gross?formatted(gross):"",net_weight_kg:net?formatted(net):"",total_gross_weight_kg:gross?formatted(qty*gross):"",total_net_weight_kg:net?formatted(qty*net):"",
 };});
 const transports=input.transports.map((transport)=>{const carrier=object(transport.carrier);const carrierParty=object(carrier.counterparty);const vehicle=object(transport.vehicle);return{sequence_no:number(transport.sequence_no),carrier_name:partyName(carrierParty),vehicle_plate:text(vehicle.plate_number),trailer_plate:text(vehicle.trailer_plate_number),driver_name:text(transport.driver_name),driver_phone:text(transport.driver_phone),temperature_setpoint:text(transport.temperature_setpoint),planned_loading_date:date(transport.planned_loading_date),actual_loading_date:date(transport.actual_loading_date),planned_arrival_date:date(transport.planned_arrival_date),actual_arrival_date:date(transport.actual_arrival_date)};});
 return{
  generated_date:date(input.now??new Date()),shipment_number:text(s.shipment_number),project_code:text(s.project_code),shipment_type:text(s.type),shipment_status:text(s.status),incoterms:text(s.incoterms),planned_ready_date:date(s.planned_ready_date),planned_arrival_date:date(s.planned_arrival_date),
  supplier_name:partyName(input.supplier),supplier_tax_id:text(input.supplier?.tax_id),supplier_country:text(input.supplier?.country),customer_name:partyName(input.customer),customer_tax_id:text(input.customer?.tax_id),customer_country:text(input.customer?.country),
  route_name:localized(input.route?.name),destination_warehouse:localized(input.warehouse?.name),destination_address:text(input.warehouse?.address),responsible_name:text(input.responsible?.full_name),currency_code:text(input.currency?.code),contract_number:text(input.contract?.number),
  total_lines:items.length,total_quantity:formatted(totalQuantity),total_amount:input.includePrices?formatted(totalAmount,2):"",total_gross_weight_kg:totalGross?formatted(totalGross):"",total_net_weight_kg:totalNet?formatted(totalNet):"",items,transports,
 };
}

export function missingGenerationFields(variables:TemplateVariable[],data:Record<string,unknown>){
 const rows=[...(Array.isArray(data.items)?data.items:[]),...(Array.isArray(data.transports)?data.transports:[])].filter(value=>value&&typeof value==="object") as Record<string,unknown>[];
 return variables.filter(variable=>{const value=data[variable.key];const nested=rows.filter(row=>variable.key in row);if(value===undefined&&nested.length)return nested.some(row=>row[variable.key]===undefined||row[variable.key]===null||row[variable.key]==="");return value===undefined||value===null||value===""||(Array.isArray(value)&&value.length===0);});
}

export function generatedFileName(templateName:string,shipmentNumber:string){
 const extension=templateName.toLowerCase().endsWith(".xlsx")?"xlsx":"docx";
 const stem=templateName.replace(/\.(docx|xlsx)$/i,"").replace(/[^A-Za-zА-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,70)||"document";
 const shipment=shipmentNumber.replace(/[^A-Za-z0-9._-]+/g,"-").slice(0,40)||"shipment";
 return `${stem}-${shipment}.${extension}`;
}
