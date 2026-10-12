// Read-only archivist tools. Values are assembled from a fixed registry, not model-written text.
import { SYSTEM_SECTIONS, SYSTEM_BY_KEY } from "./system-registry.ts";
import { maskDataText, maskOutgoing, maskSensitive } from "./masking.ts";
import type { AgentTool, ToolField, ToolRow, ShipmentRow } from "./types.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABELS: Record<string, string> = {
 internal_sku:"Артикул", name:"Название", brand:"Бренд", category:"Категория", country_of_origin:"Страна происхождения", composition:"Состав", hs_code:"ТН ВЭД", shelf_life_days:"Срок годности, дней", temperature_regime:"Режим хранения", temperature_range:"Температура хранения", base_uom:"Базовая единица", status:"Статус", requires_marking:"Нужна маркировка", requires_sticker:"Нужен стикер",
 protein_g:"Белки, г",fat_g:"Жиры, г",carbohydrates_g:"Углеводы, г",energy_kcal:"Энергия, ккал",energy_kj:"Энергия, кДж",saturated_fat_g:"Насыщенные жиры, г",sugars_g:"Сахара, г",fiber_g:"Клетчатка, г",salt_g:"Соль, г",basis:"На какое количество",nutrition_facts:"Пищевая ценность",
 legal_name:"Юридическое название",short_name:"Короткое название",country:"Страна",roles:"Роли контрагента",website:"Сайт",min_remaining_shelf_life_pct:"Минимальный ОСГ, %",number:"Номер",type:"Тип",sign_date:"Дата подписания",valid_from:"Действует с",valid_to:"Действует до",incoterms:"Инкотермс",notes:"Примечание",code:"Код",city:"Город",address:"Адрес",is_virtual:"Виртуальный",zone:"Зона",origin_country:"Страна отправления",destination_country:"Страна назначения",via_countries:"Транзитные страны",typical_transit_days:"Типичный срок, дней",
 uom:"Единица",units_per_parent:"Единиц в упаковке",gross_weight_kg:"Вес брутто, кг",net_weight_kg:"Вес нетто, кг",volume_m3:"Объём, м³",length_cm:"Длина, см",width_cm:"Ширина, см",height_cm:"Высота, см",identifier_type:"Тип артикула/штрихкода",value:"Артикул/штрихкод",is_primary:"Основной",
 ordered_quantity:"Заказано",confirmed_quantity:"Подтверждено",shipped_quantity:"Отгружено",received_quantity:"Принято",quantity:"Количество",quantity_on_hand:"На складе",quantity_reserved:"В резерве",batch_number:"Партия",manufacture_date:"Изготовлено",expiry_date:"Годен до",received_at:"Получено",sale_number:"Заказ клиента",sale_date:"Дата продажи",planned_shipment_date:"Плановая отгрузка",shipment_number:"Поставка",project_code:"Проект",planned_ready_date:"Плановая готовность",planned_arrival_date:"Плановое прибытие",priority:"Приоритет",due_at:"Срок",title:"Название",description:"Описание",body:"Текст",comment:"Комментарий",status_reason:"Причина статуса",movement_type:"Вид движения",reference:"Основание",reason:"Причина",
 document_number:"Номер документа",document_date:"Дата документа",valid_until:"Действует до",language:"Язык",current_version:"Текущая версия",card_number:"Номер карты",card_type:"Вид карты",effective_date:"Дата действия",order_number:"Номер заказа",quantity_requested:"Запрошено кодов",quantity_received:"Получено кодов",quantity_applied:"Нанесено кодов",languages:"Языки",sticker_level:"Уровень стикера",version:"Версия",version_number:"Версия",horizon_start:"Период с",horizon_end:"Период до",period_start:"Начало периода",base_quantity:"Базовый прогноз",promo_uplift_quantity:"Прирост по акции",final_quantity:"Итоговый прогноз",suggested_quantity:"Рекомендованная закупка",rounded_quantity:"Закупка с округлением",approved_quantity:"Согласованная закупка",safety_stock:"Страховой запас",stock_in_transit:"В пути",stock_on_hand:"На складе",stock_reserved:"Резерв",planned_order_date:"Дата заказа",starts_on:"Начало",ends_on:"Окончание",
 base_purchase_price:"Закупочная цена",unit_price:"Цена единицы",price:"Цена",target_unit_price:"Целевая цена",discount_pct:"Скидка, %",expense_type:"Вид расхода",amount:"Сумма",incurred_at:"Дата расхода",paid_at:"Оплачено",confirmed_at:"Подтверждено",is_planned:"Плановый",goods_total:"Стоимость товара",expenses_total:"Дополнительные расходы",landed_total:"Полная себестоимость",goods_amount:"Закупочная стоимость",allocated_expenses:"Распределённые расходы",landed_amount:"Полная стоимость",unit_landed_cost:"Себестоимость единицы",calculated_at:"Рассчитано",approved_at:"Утверждено",currency_id:"Идентификатор валюты",rate:"Курс",rate_date:"Дата курса",source:"Тип источника",source_name:"Источник",
 is_active:"Активно",is_read:"Прочитано",last_status:"Состояние",last_run_at:"Последний запуск",last_success_at:"Последний успех",started_at:"Начато",finished_at:"Завершено",records_read:"Прочитано записей",records_created:"Создано",records_updated:"Обновлено",records_failed:"Ошибок",created_at:"Создано",updated_at:"Обновлено",action:"Действие",entity_type:"Тип объекта",source_key:"Источник калькулятора",source_row:"Строка источника",imported_at:"Импортировано",full_name:"Имя сотрудника",job_title:"Должность",granted:"Право выдано",module:"Раздел",audience:"Тип роли",
};
const NUTRITION = ["energy_kcal","energy_kj","protein_g","fat_g","saturated_fat_g","carbohydrates_g","sugars_g","fiber_g","salt_g"];
const MONEY_FIELDS=["base_purchase_price","unit_price","price","target_unit_price","amount","goods_total","expenses_total","landed_total","goods_amount","allocated_expenses","landed_amount","unit_landed_cost"];
const FIELDS: ToolField[] = [{key:"price_source",label:"Источник цены",kind:"text"},{key:"currency_code",label:"Валюта",kind:"text"},{key:"units_per_parent",label:"Количество штук",kind:"number"},{key:"uom",label:"Уровень упаковки",kind:"text"},...MONEY_FIELDS.map(key=>({key,label:LABELS[key],kind:"financial" as const})),{key:"contact_name",label:"Контакт",kind:"protected"},{key:"contact_phone",label:"Телефон",kind:"protected"},{key:"contact_email",label:"Email",kind:"protected"},{key:"public_code",label:"Артикул / штрихкод",kind:"protected"},{ key:"record_id",label:"Идентификатор записи",kind:"id" },{key:"record_details",label:"Данные Nexus",kind:"text"}];
function object(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {}; }
function scalar(v: unknown): string | null {
 if (typeof v === "number") return Number.isFinite(v) ? new Intl.NumberFormat("ru-RU",{maximumFractionDigits:6}).format(v) : null;
 if (typeof v === "boolean") return v ? "Да" : "Нет";
 if (typeof v === "string") return maskDataText(v,600);
 if (Array.isArray(v)) return v.every(item => typeof item === "string" || typeof item === "number") ? maskDataText(v.join(", "),600) : null;
 const localized=object(v); return typeof localized.ru === "string" ? maskDataText(localized.ru,1500) : typeof localized.en === "string" ? maskDataText(localized.en,1500) : null;
}
function calculatorPurchase(row: ShipmentRow): Record<string,string|number|null> {
 const columns=Array.isArray(row.source_columns)?row.source_columns as Record<string,unknown>[]:[];
 const matches=columns.filter(column=>column.visibility === "confidential" && column.field_ru === "Цена за единицу" && column.block === "Информация о закупе");
 if(matches.length!==1) return {};
 const raw=object(row.confidential_data)[String(matches[0].key)];
 if(raw===null||raw===undefined||raw==="" || !["number","string"].includes(typeof raw) || !Number.isFinite(Number(raw)) || Number(raw)<0) return {};
 const currencyColumn=columns.filter(column=>column.field_ru === "Валюта закупа" && column.block === "Информация о закупе");
 const data={...object(row.catalog_data),...object(row.sales_data),...object(row.confidential_data)};
 const currencyRaw=currencyColumn.length === 1 ? String(data[String(currencyColumn[0].key)]??"").trim().toUpperCase() : "";
 const currency=currencyRaw === "€" || currencyRaw === "ЕВРО" ? "EUR" : currencyRaw;
 return {base_purchase_price:Number(raw),price_source:"Сохранённый мастер-калькулятор",currency_code:["EUR","USD","KZT","RUB","GBP","CHF","CNY","UZS","KGS"].includes(currency)?currency:"Не указана или не распознана в источнике"};
}function details(sectionKey: string, row: ShipmentRow, requested?: string): string {
 const section=SYSTEM_BY_KEY.get(sectionKey)!;
 let selected=requested ? requested.split(",") : [];
 const allowed=new Set([...section.columns,...NUTRITION,"basis","contact_name","contact_phone","contact_email","public_code","currency_code",...(sectionKey === "calculator_finance" ? ["base_purchase_price","price_source"] : [])]);
 // Unknown presentation fields must not make a valid, authorized database read fail.
 // Fall back to the fixed safe projection; never select model-supplied columns.
 if (selected.some(key=>!allowed.has(key))) selected=[];
 const lines: string[]=[];
 for (const key of section.columns) {
  if ((["phone","whatsapp_phone","email","driver_phone","driver_name"].includes(key) || (sectionKey === "contacts" && key === "full_name")) || (sectionKey === "identifiers" && key === "value")) continue;
  if (key === "id" || key.endsWith("_id") || key === "catalog_data" || key === "sales_data") continue;
  if (selected.length && !selected.includes(key) && !(key === "nutrition_facts" && selected.some(field=>NUTRITION.includes(field)||field==="basis"))) continue;
  if (key === "nutrition_facts") {
   const nutrition=object(row[key]);
   // Never invent a basis for values with an unknown or missing basis.
   const basis={"100g":"На 100 г","100ml":"На 100 мл","serving":"На порцию"}[String(nutrition.basis)];
   lines.push(`Пищевая ценность: ${basis ?? "основа не указана"}`);
   for (const field of NUTRITION) if (!selected.length || selected.includes(field) || selected.includes("nutrition_facts")) {
    const value=nutrition[field];
    if (typeof value === "number" && Number.isFinite(value) && value>=0) lines.push(`${LABELS[field]}: ${scalar(value)}`);
    else lines.push(`${LABELS[field]}: не заполнено`);
   }
   continue;
  }
  const normalized = MONEY_FIELDS.includes(key) && row[key]!==null && row[key]!==undefined && Number.isFinite(Number(row[key])) ? Number(row[key]) : row[key];
  const value=scalar(normalized); if(value!==null) lines.push(`${LABELS[key] ?? key}: ${value}`);
 }
 if(sectionKey === "calculator" || sectionKey === "calculator_finance") {
  const values={...object(row.catalog_data),...object(row.sales_data),...(sectionKey === "calculator_finance" ? object(row.confidential_data) : {})};
  const columns=Array.isArray(row.source_columns) ? row.source_columns as Record<string,unknown>[] : [];
  for(const column of columns) {
   const key=String(column.key);
   if(selected.length && !selected.includes("catalog_data") && !selected.includes("sales_data") && !selected.includes("confidential_data") && !selected.includes(key)) continue;
   if(!["catalog","sales","confidential"].includes(String(column.visibility)) || /password|token|secret|passport|driver_document|iin|парол|токен|секрет|паспорт|удостовер|иин/i.test(String(column.field_en??column.field_ru))) continue;
   const value=scalar(values[key]); if(value!==null) lines.push(`${maskDataText(String(column.field_ru??column.field_en??key),120)}: ${value}`);
  }
 }
 if(sectionKey === "calculator_finance" && selected.includes("base_purchase_price")) {
  const price=calculatorPurchase(row); if(price.base_purchase_price!==undefined) lines.push(`Закупочная цена: ${scalar(price.base_purchase_price)}`, `Валюта: ${price.currency_code}`, `Источник цены: ${price.price_source}`);
 }
 if(row.currency_id || row.cost_currency_id) lines.push(`Валюта: ${typeof row.currency_code === "string" && /^[A-Z]{3}$/.test(row.currency_code) ? row.currency_code : "не определена"}`);
 return maskOutgoing(lines.join("\n")) || "Разрешённые поля записи не заполнены.";
}
const common = {
 section:{type:"enum" as const,values:SYSTEM_SECTIONS.map(section=>section.key),description:"Раздел Nexus; выбирай только доступный раздел"},
 fields:{type:"string" as const,maxLength:200,pattern:/^[a-z_]+(?:,[a-z_]+)*$/,optional:true,description:"Необязательное сужение отображения: только известные поля, например nutrition_facts или protein_g,fat_g,carbohydrates_g. Если названия полей неизвестны, не передавай fields: вернётся полная разрешённая карточка"},
};
const description="Товары и КБЖУ: products; исходные поля: calculator; цены: product_prices,shipment_prices,inventory_costs,calculator_finance; контакты: contacts,transports; упаковка: packaging; календарь: calendar; контрагенты: counterparties; договоры: contracts,contract_terms; склад: batches,balances,movements; продажи: sales,sale_items; планы: forecasts,purchase_plans,programs и строки; финансы: expenses,cost_calculations,cost_items,exchange_rates; документы и листинг: documents,templates,listing_cards; стикеры: stickers,sticker_orders,marking; история: audit,sync_runs.";
const scope={param:"section",sections:SYSTEM_SECTIONS};
const searchSystem: AgentTool={
 name:"search_system",description:`Справочный поиск по всей системе с текущими правами. ${description}. Используй для характеристик товара, КБЖУ, связанных строк и финансов. Полученные UUID нужны для карточки и связанного поиска.`,permissions:[],scope,
 params:{...common,
 query:{type:"string",maxLength:60,pattern:/^[\p{L}\p{N} _.\-/№]+$/u,optional:true,description:"Название, артикул или номер; не используйте query для разделов без текстового поиска"},
 status:{type:"string",maxLength:30,pattern:/^[a-z_]+$/,optional:true,description:"Статус, если есть в разделе"},
 date:{type:"date",optional:true,description:"Начало периода YYYY-MM-DD"},date_to:{type:"date",optional:true,description:"Конец периода включительно YYYY-MM-DD"},
 parent_id:{type:"uuid",optional:true,description:"Идентификатор связанного объекта: товара, поставки, заказа, договора, расчёта"},
 related_by:{type:"string",maxLength:40,pattern:/^[a-z_]+_id$/,optional:true,description:"Разрешённая FK-колонка раздела, например product_id, shipment_id, customer_id; по умолчанию основная связь"},
 offset:{type:"integer",min:0,max:10000,optional:true,description:"Начало страницы, по умолчанию 0"},limit:{type:"integer",min:1,max:20,optional:true,description:"Размер страницы, не больше 20"}},
 fields:FIELDS,maxRows:20,timeoutMs:8000,
 async run(ctx,params){
  const section=SYSTEM_BY_KEY.get(String(params.section))!;
  const {rows,total}=await ctx.data.readSystem({section:section.key,userId:ctx.userId,query:params.query as string|undefined,status:params.status as string|undefined,date:params.date as string|undefined,dateTo:params.date_to as string|undefined,parentId:params.parent_id as string|undefined,relatedBy:params.related_by as string|undefined,offset:Number(params.offset??0),limit:Number(params.limit??20)},ctx.signal);
  const shown=rows.slice(0,Number(params.limit??20)).map(row=>systemRow(section.key,row,params.fields as string|undefined));
  return {requiredPermissions:conditionalPermissions(section.key,rows),rows:shown,total,truncated:Number(params.offset??0)>0 || total===null || total>shown.length,notes:[`Источник: ${section.title}. Данные прочитаны с текущими правами сотрудника.${section.date ? ` Фильтр периода применяется к ${LABELS[section.date]??section.date}.` : ""}`]};
 },
};
function protectedValues(key:string,row:ShipmentRow):Record<string,string> {
 const values:Record<string,string>={};
 if(key === "contacts" || key === "transports") {
  const name=key === "contacts" ? row.full_name : row.driver_name; if(typeof name === "string") values.contact_name=maskSensitive(name).text.slice(0,160);
  const phone=key === "contacts" ? row.phone??row.whatsapp_phone : row.driver_phone;
  if(typeof phone === "string" && /^[+() 0-9-]{7,30}$/.test(phone) && phone.replace(/\D/g,"").length<=15) values.contact_phone=phone;
  if(key === "contacts" && typeof row.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) values.contact_email=maskSensitive(row.email).text.slice(0,160);
 }
 if(key === "identifiers" && typeof row.value === "string" && ["gtin","unit_barcode","box_barcode","supplier_sku"].includes(String(row.identifier_type))) values.public_code=maskSensitive(row.value).masked ? (/^(?:\d{8}|\d{12,14})$/.test(row.value) ? row.value : "[скрыто]") : row.value.slice(0,80);
 return values;
}
function conditionalPermissions(section:string,rows:ShipmentRow[]):string[] {
 return (section === "expenses" && rows.some(row=>row.expense_type === "goods_cost")) || (section === "contract_terms" && rows.some(row=>row.term_type === "price")) ? ["prices.purchase.view"] : [];
}
function systemRow(key:string,source:ShipmentRow,fields?:string):ToolRow {
 const section=SYSTEM_BY_KEY.get(key)!;
 const row:ShipmentRow=Object.fromEntries(section.columns.filter(field=>Object.hasOwn(source,field)).map(field=>[field,source[field]]));
 if(key === "calculator" || key === "calculator_finance") row.source_columns=source.source_columns;
 if(key === "calculator_finance") row.confidential_data=source.confidential_data;
 if(section.columns.includes("currency_id") || section.columns.includes("cost_currency_id")) row.currency_code=source.currency_code;
 const id=String(row[section.idColumn]??"");
 const references=Object.fromEntries(Object.entries(row).filter(([field,value])=>section.columns.includes(field)&&field.endsWith("_id")&&typeof value==="string"&&UUID.test(value)).map(([field,value])=>[field,String(value)]));
 const name=scalar(row.internal_sku??row.shipment_number??row.sale_number??row.number??row.name??row.title??row.legal_name??row.batch_number);
 return {subject:`${section.title}${name?` · ${name}`:""}`.slice(0,200),values:{record_id:id,record_details:details(key,row,fields), ...(key === "calculator_finance" ? calculatorPurchase(row) : {}), ...(key === "packaging" ? {units_per_parent: typeof row.units_per_parent === "number" ? row.units_per_parent : Number.isFinite(Number(row.units_per_parent)) ? Number(row.units_per_parent) : null,uom: typeof row.uom === "string" ? ({piece:"Штука",box:"Короб",pallet:"Паллета",truck:"Машина"}[row.uom] ?? row.uom) : null} : {}), ...protectedValues(key,row), ...Object.fromEntries(MONEY_FIELDS.filter(field=>section.columns.includes(field) && row[field]!==null && row[field]!==undefined && Number.isFinite(Number(row[field]))).map(field=>[field,Number(row[field])]))},
 ...(UUID.test(id)?{entity:{type:"system" as const,id,section:key}}:{}),references};
}
const recordScope={param:"section",sections:SYSTEM_SECTIONS.filter(section=>!["calendar","shipment_prices","inventory_costs"].includes(section.key))};
const getSystemRecord:AgentTool={name:"get_system_record",description:"Полная карточка найденного объекта Nexus. Сначала получи record_id поиском; для КБЖУ products, для исходных значений из калькулятора calculator, для цены product_prices. Ничего не изменяет.",permissions:[],scope:recordScope,
 params:{...common,record_id:{type:"uuid",description:"UUID найденной записи"}},fields:FIELDS,maxRows:20,timeoutMs:8000,
 async run(ctx,params){const section=String(params.section);const {rows,total}=await ctx.data.readSystem({section,userId:ctx.userId,recordId:String(params.record_id),parentId:section==="calculator"||section==="calculator_finance"||section==="product_prices"?String(params.record_id):undefined,offset:0,limit:20},ctx.signal);
 return {requiredPermissions:conditionalPermissions(section,rows),rows:rows.map(row=>systemRow(section,row,params.fields as string|undefined)),total,truncated:total===null||total>rows.length,notes:rows.length?[]:["Объект не найден или недоступен с текущими правами."]};},};
export const SYSTEM_TOOLS:readonly AgentTool[]=[searchSystem,getSystemRecord];
