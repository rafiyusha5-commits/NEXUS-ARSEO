import { isElectronicInvoice, parseElectronicInvoice } from "./esf.ts";

export const EXTRACTION_VERSION = "rules-v3";

export type ExtractionEvidence = { label: string; value: string; confidence: number };
export type ExtractionConflict = { field: string; values: string[]; documents?: string[] };
export type ExtractionResult = {
  data: Record<string, unknown>;
  evidence: Record<string, ExtractionEvidence>;
  conflicts: ExtractionConflict[];
};

export type SourceFieldDefinition = { key: string; label: string; type: "text" | "date" | "number" };

type Pattern = { field: string; label: string; expressions: RegExp[]; confidence?: number };

const patterns: Pattern[] = [
  { field: "order_number", label: "Номер заказа", expressions: [/(?:номер\s+заказа|заказ(?:а|у)?\s*(?:№|#|номер|no))\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{1,40})/iu] },
  { field: "invoice_number", label: "Номер инвойса", expressions: [/(?:invoice|инвойс|сч[её]т[- ]фактура)[ \t]*(?:no\.?|number|номер|№|#)[ \t]*\)?[ \t]*[:№#-]?[ \t]*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{0,40})/iu, /(?:invoice|инвойс|сч[её]т[- ]фактура)\s*(?:№|#)?\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{1,40})/iu] },
  { field: "contract_number", label: "Номер договора", expressions: [/(?:договор(?:-заявк[аи])?|контракт)[^\n]{0,80}?\s(?:№|#|no|номер)\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{1,60})/iu] },
  { field: "cmr_number", label: "Номер CMR", expressions: [/CMR\s*(?:№|#)?\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{0,30})/iu] },
  { field: "ttn_number", label: "Номер ТТН", expressions: [/ТТН\s*(?:№|#)?\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{0,30})/iu] },
  { field: "packing_list_number", label: "Номер упаковочного листа", expressions: [/упаковочн(?:ый|ого)\s+лист(?:а)?\s*(?:№|#)?\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{0,30})/iu] },
  { field: "waybill_number", label: "Номер накладной", expressions: [/(?:накладная|накладной)\s*(?:№|#)?\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{0,40})/iu] },
  { field: "esf_number", label: "Номер ЭСФ", expressions: [/(?:ЭСФ|электронн\S*\s+сч[её]т[- ]фактур\S*)\s*(?:№|#)?\s*[:№#-]?\s*([A-ZА-Я0-9][A-ZА-Я0-9./_-]{0,40})/iu] },
  { field: "driver_name", label: "Водитель", expressions: [/(?:ФИО\s+водителя|фамилия\s+и\s+инициалы\s+водителя|водитель)\s*[:—-]\s*(\p{Lu}[\p{L}.-]+(?:[ \t]+\p{Lu}[\p{L}.-]+){1,3})/iu, /ФИО[^\n]{0,100}\n\s*водителя(?:\s*\n\s*Номер[^\n]*)?\s*\n\s*(\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+){1,3})/u] },
  { field: "driver_document", label: "Документ водителя", expressions: [/NEXUS_DOCUMENT_NUMBER\s*:\s*(\d{9})/u, /(?:уд\/лич|удостоверени\S*\s+(?:личности|водителя)|паспорт(?:ные\s+данные)?\s+водителя)\s*[:№—-]?\s*([^\n]{5,180})/iu, /паспорт\s*[:№—-]\s*([^\n]{5,180})/iu] },
  { field: "driver_phone", label: "Телефон водителя", expressions: [/(?:телефон\S*\s+водителя|моб\.?\s*тел\.?\s+водителя)\s*[:—-]?\s*(\+?[0-9][0-9 ()-]{7,20})/iu] },
  { field: "vehicle_plate", label: "Госномер автомобиля", expressions: [/(?:гос\.?\s*номер\s+(?:авто|тягача)|регистрац\S*\s+номер\s+тягача)\s*[:—-]?\s*([A-ZА-Я0-9 -]{4,20})/iu] },
  { field: "vehicle_make", label: "Марка автомобиля", expressions: [/(?:марка\s+(?:авто|тягача)|автомобиль|машина)\s*[:—-]\s*([A-ZА-Я][A-ZА-Я0-9 .\/-]{2,50})/iu] },
  { field: "trailer_plate", label: "Госномер прицепа", expressions: [/(?:гос\.?\s*номер\s+(?:прицепа|полуприцепа)|прицеп\s+(?:№|номер)?)\s*[:—-]?\s*([A-ZА-Я0-9 -]{4,20})/iu] },
  { field: "trailer_make", label: "Марка прицепа", expressions: [/(?:марка\s+(?:прицепа|полуприцепа))\s*[:—-]?\s*([A-ZА-Я][A-ZА-Я0-9 .\/-]{2,60})/iu] },
  { field: "carrier_name", label: "Перевозчик", expressions: [/^\s*(?:наименование\s+перевозчика|перевозчик)\s*[:—-]?\s*(?:\n\s*)?([^\n]{3,160})/imu] },
  { field: "loading_address", label: "Адрес погрузки", expressions: [/^\s*(?:адрес(?:\s+места)?|пункт|место)\s+(?:погрузки|загрузки)\s*[:—-]?\s*([^\n]{5,250})/imu] },
  { field: "unloading_address", label: "Адрес разгрузки", expressions: [/^\s*(?:адрес(?:\s+места)?|пункт|место)\s+(?:разгрузки|выгрузки)\s*[:—-]?\s*([^\n]{5,300})/imu] },
  { field: "seals", label: "Номера пломб", expressions: [/(?:номер(?:а)?\s+пломб|пломб[аы])\s*[:—-]?\s*([A-ZА-Я0-9,; /-]{3,100})/iu] },
  { field: "temperature_setpoint", label: "Температурный режим", expressions: [/(?:температурн\S*\s+режим)\s*[:—-]?\s*([+−-]?[0-9]{1,2}\s*(?:°?C)?\s*(?:[-–—]\s*[+]?[0-9]{1,2}\s*°?C?)?)/iu] },
  { field: "pallet_count", label: "Количество паллет", expressions: [/(?:количество|кол-во|к-во)\s+(?:паллет|поддонов)\s*[:—-]?\s*([0-9]{1,5})/iu] },
  { field: "gross_weight_kg", label: "Вес брутто", expressions: [/(?:вес|масса)\s+брутто(?:\s*,?\s*кг)?\s*[:—-]?\s*([0-9][0-9 .,]{0,20})/iu] },
  { field: "net_weight_kg", label: "Вес нетто", expressions: [/(?:вес|масса)\s+нетто(?:\s*,?\s*кг)?\s*[:—-]?\s*([0-9][0-9 .,]{0,20})/iu] },
  { field: "incoterms", label: "Условия поставки", expressions: [/inco\s+terms?\s*[:—-]\s*(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)(?![A-Z])/iu, /(?:условия\s+(?:поставки|оплаты)|incoterms?)\s*[:—-]?\s*([^\n]{3,180})/iu] },
  // Requisites that the export CMR / ТТН / packing list print and the counterparty directory does not hold.
  { field: "loading_city", label: "Город погрузки", expressions: [/город\s+погрузки\s*[:—-]?\s*([^\n]{2,80})/iu] },
  { field: "loading_country", label: "Страна погрузки", expressions: [/страна\s+погрузки\s*[:—-]?\s*([^\n]{2,60})/iu] },
  { field: "unloading_country", label: "Страна разгрузки", expressions: [/страна\s+(?:разгрузки|выгрузки|доставки)\s*[:—-]?\s*([^\n]{2,60})/iu] },
  { field: "goods_category", label: "Категория товаров", expressions: [/категори\S*\s+товар\S*\s*[:—-]?\s*([^\n]{3,160})/iu] },
  { field: "payment_terms", label: "Условия оплаты", expressions: [/условия\s+оплаты\s*[:—-]?\s*([^\n]{3,180})/iu] },
  { field: "supplier_address", label: "Адрес продавца", expressions: [/адрес\s+(?:продавца|поставщика|отправителя)\s*[:—-]?\s*([^\n]{5,250})/iu] },
  { field: "seller_correspondence_address", label: "Адрес продавца для корреспонденции", expressions: [/адрес\s+для\s+корреспонденции\s*[:—-]?\s*([^\n]{5,250})/iu] },
  { field: "seller_phone", label: "Телефон продавца", expressions: [/телефон\S*\s+(?:продавца|поставщика)\s*[:—-]?\s*(\+?[0-9][0-9 ()-]{7,20})/iu] },
  { field: "customer_address", label: "Адрес покупателя", expressions: [/адрес\s+(?:покупателя|получателя)\s*[:—-]?\s*([^\n]{5,250})/iu] },
  { field: "customer_kpp", label: "КПП покупателя", expressions: [/кпп\s*[:—-]?\s*([0-9]{9})/iu] },
];

// Reviewed by hand: free-form multi-line blocks that no stable label identifies in a document.
const manualFields: SourceFieldDefinition[] = [
  { key: "bank_details", label: "Банк-корреспондент продавца (реквизиты)", type: "text" },
  { key: "sender_signatory", label: "Подписант отправителя (ФИО и должность)", type: "text" },
];

const datePatterns: Array<[string, string, RegExp[]]> = [
  ["order_date", "Дата заказа", [/(?:дата\s+заказа)\s*[:—-]?\s*([0-3]?\d[./-][01]?\d[./-](?:20)?\d{2})/iu]],
  ["shipping_date", "Дата отгрузки", [/(?:дата\s+отгрузки(?:\s+по\s+документам)?)\s*[:—-]?\s*([0-3]?\d[./-][01]?\d[./-](?:20)?\d{2})/iu]],
  ["invoice_date", "Дата инвойса", [/(?:invoice\s+date)\s*\)?\s*[:—-]?\s*(20\d{2}-[01]\d-[0-3]\d|[0-3]?\d[./-][01]?\d[./-](?:20)?\d{2})/iu, /(?:дата\s+(?:инвойса|сч[её]та[- ]фактуры))\s*[:—-]?\s*([0-3]?\d[./-][01]?\d[./-](?:20)?\d{2})/iu]],
  ["contract_date", "Дата договора", [/(?:дата\s+(?:договора|контракта))\s*[:—-]?\s*([0-3]?\d[./-][01]?\d[./-](?:20)?\d{2})/iu]],
];

export const SOURCE_FIELD_DEFINITIONS: SourceFieldDefinition[] = [
  ...patterns.map(pattern => ({ key: pattern.field, label: pattern.label, type: (["pallet_count", "gross_weight_kg", "net_weight_kg"].includes(pattern.field) ? "number" : "text") as SourceFieldDefinition["type"] })),
  ...datePatterns.map(([key, label]) => ({ key, label, type: "date" as const })),
  ...manualFields,
];

const sourceFieldKeys = new Set(SOURCE_FIELD_DEFINITIONS.map(field => field.key));

export function sanitizeConfirmedSourceData(value: Record<string, unknown>) {
  const cleanData: Record<string, string | number> = {};
  for (const field of SOURCE_FIELD_DEFINITIONS) {
    const raw = value[field.key];
    if (raw === null || raw === undefined || raw === "") continue;
    if (!sourceFieldKeys.has(field.key) || typeof raw === "object") continue;
    if (field.type === "number") {
      const parsed = Number(String(raw).replace(/\s/g, "").replace(",", "."));
      if (Number.isFinite(parsed) && parsed >= 0) cleanData[field.key] = parsed;
      continue;
    }
    const cleaned = clean(String(raw)).slice(0, field.key.endsWith("address") || field.key === "bank_details" ? 500 : 200);
    if (cleaned) cleanData[field.key] = field.type === "date" ? isoDate(cleaned) : cleaned;
  }
  return cleanData;
}

const explicitSourceKinds = new Set(["invoice", "specification", "contract", "transport_order", "vehicle_document", "driver_document", "waybill"]);

export function shipmentSourceKindFromDocumentType(code: string) {
  if (["cmr", "ttn"].includes(code)) return "waybill";
  if (code === "packing_list") return "specification";
  if (["supplier_contract", "customer_contract"].includes(code)) return "contract";
  return explicitSourceKinds.has(code) ? code : "other";
}

export function detectShipmentSourceKind(rawText: string, hintedKind = "other") {
  // A type selected by the employee describes this document, whereas its text may
  // refer to other documents (a CMR normally lists its attached invoice).
  if (explicitSourceKinds.has(hintedKind)) return hintedKind;
  if (isElectronicInvoice(rawText)) return "invoice";
  const text = rawText.toLocaleLowerCase("ru-RU");
  if (/\b(invoice|инвойс|сч[её]т[- ]фактура)\b/u.test(text)) return "invoice";
  if (/договор[- ]заявк|transport\s+order|заявк\S*\s+на\s+перевоз/u.test(text)) return "transport_order";
  if (/водительск\S*\s+удостоверен|driver'?s?\s+licen[cs]e|паспорт\s+водителя/u.test(text)) return "driver_document";
  if (/свидетельств\S*\s+о\s+регистрации|vehicle\s+registration|техпаспорт/u.test(text)) return "vehicle_document";
  if (/упаковочн\S*\s+лист|packing\s+list/u.test(text)) return "specification";
  if (/\bcmr\b|товарно[- ]транспортн|\bттн\b/iu.test(text)) return "waybill";
  return hintedKind;
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[\s:;,.–—-]+|[\s:;,]+$/g, "").trim();
}

function isoDate(value: string) {
  const normalized = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const parts = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!parts) return normalized;
  const year = parts[3].length === 2 ? `20${parts[3]}` : parts[3];
  return `${year}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
}

// ---- values that are really the next printed label ---------------------------------------------------------------------
// A form flattened to text (and OCR above all) puts labels and values side by side. When a value is missing, a
// pattern that reads "after the label" picks up the NEXT label ("Гос.номер авто:" -> "Марка авто"). Such a value is
// refused, and a label glued to the tail of a real value ("Иванов Иван Телефон") is cut off.
const LABEL_WORDS = String.raw`гос\.?\s*номер|марка\s+(?:авто|тягача|прицепа|полуприцепа)|номер\s+а\s*\/\s*м|телефон|тел\.|водител[ья]|ф\.?\s?и\.?\s?о\b|перевозчик|(?:полу)?прицеп|тягач|количество|кол-во|пломб|температур|уд\s*\/\s*лич|паспорт|удостоверени`;
const LABEL_AT_START = new RegExp(`^(?:${LABEL_WORDS})`, "iu");
const LABEL_INSIDE = new RegExp(`(?<![\p{L}\p{N}])(?:${LABEL_WORDS})`, "iu");
const LABEL_SENSITIVE = new Set(["driver_name", "driver_document", "vehicle_plate", "vehicle_make", "trailer_plate", "trailer_make", "seals", "carrier_name"]);

export function cleanFieldValue(field: string, value: string) {
  if (!LABEL_SENSITIVE.has(field)) return value;
  if (LABEL_AT_START.test(value)) return "";
  const inside = LABEL_INSIDE.exec(value);
  return inside && inside.index > 0 ? value.slice(0, inside.index).replace(/[\s,;:–—-]+$/u, "") : value;
}

// A value of the right shape is not necessarily right, but one of the wrong shape is certainly worth a second look.
const PLATE_SHAPE = /^(?:\d{2,3}[A-ZА-ЯЁ]{2,3}\d{2,3}|[A-ZА-ЯЁ]\d{3}[A-ZА-ЯЁ]{2}\d{2,3})$/iu;
export function looksPlausible(field: string, value: string) {
  if (field === "vehicle_plate" || field === "trailer_plate") return PLATE_SHAPE.test(value.replace(/[\s-]+/g, ""));
  if (field === "driver_phone") return value.replace(/\D/g, "").length >= 10;
  if (field === "driver_document") return /\d{6,}/.test(value.replace(/\s/g, ""));
  return true;
}

export type ExtractOptions = {
  /** The text comes from the OCR service, which may prepend its own marker lines (see NEXUS_DOCUMENT_NUMBER). */
  fromOcr?: boolean;
};

const IDENTITY_CARD = /УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ|ЖЕКЕ\s+КУӘЛІК/iu;
const INVOICE_LABEL_VALUES = new Set(["NO", "NUMBER", "NUMER", "FAKTURY", "DATE", "INVOICE", "НОМЕР", "ДАТА", "ИНВОЙС"]);

export function extractShipmentFields(rawText: string, options: ExtractOptions = {}): ExtractionResult {
  const text = rawText.replace(/\r/g, "\n").replace(/[\t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n");
  const data: Record<string, unknown> = {};
  const evidence: Record<string, ExtractionEvidence> = {};
  for (const pattern of patterns) {
    for (const expression of pattern.expressions) {
      const match = expression.exec(text);
      if (!match?.[1]) continue;
      const value = cleanFieldValue(pattern.field, clean(match[1]));
      if (!value) continue;
      if (pattern.field === "invoice_number" && INVOICE_LABEL_VALUES.has(value.toLocaleUpperCase("ru-RU"))) continue;
      // The marker line of the OCR service is trusted only when it really comes from the service.
      if (/^NEXUS_DOCUMENT_NUMBER/u.test(match[0]) && !(options.fromOcr && IDENTITY_CARD.test(text) && /^\s*NEXUS_DOCUMENT_NUMBER/u.test(text))) continue;
      // OCR can put the next printed label on the same line as a field heading. A driver
      // document value without any digit is a label/name, not an identity-document number.
      if (pattern.field === "driver_document" && !/\d/u.test(value)) continue;
      data[pattern.field] = ["pallet_count", "gross_weight_kg", "net_weight_kg"].includes(pattern.field) ? Number(value.replace(/\s/g, "").replace(",", ".")) : value;
      evidence[pattern.field] = { label: pattern.label, value, confidence: looksPlausible(pattern.field, value) ? pattern.confidence ?? 0.85 : 0.55 };
      break;
    }
  }
  // Kazakhstan identity cards lay surname, name and patronymic out on separate labelled lines.
  // Tesseract commonly reads ТЕГ as ТЕП, so accept that spelling but keep the result for review.
  if (!data.driver_name && /УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ/iu.test(text)) {
    const identityName = text.match(/(?:ТЕГІ|ТЕГ|ТЕП|ТЕГ1)\s*\/\s*ФАМИЛИЯ\s*\n+\s*(\p{Lu}[\p{L}0-9-]+)\s*\n+\s*АТЫ\s*\/\s*ИМЯ\s*\n+\s*(\p{Lu}[\p{L}0-9-]+)\s*\n+\s*ӘКЕСІНІҢ\s+АТЫ\s*\/\s*ОТЧЕСТВО[,.]?\s*\n+\s*(\p{Lu}[\p{L}0-9-]+)/u);
    if (identityName) {
      const value = identityName.slice(1, 4).join(" ");
      data.driver_name = value;
      evidence.driver_name = { label: "Водитель", value, confidence: 0.7 };
    }
  }
  // Kazakhstan vehicle registration certificates encode plate and make as numbered fields 1 and 2.
  if (/CERTIFICAT\s+D['’]?IMMATRICULATION|СВИДЕТЕЛЬСТВ\S*\s+О\s+РЕГИСТРАЦИИ/iu.test(text)) {
    const registration = text.match(/(?:^|\n)\s*1\.\s*([A-ZА-Я0-9]{5,14})\s+2\.\s*([A-ZА-Я][A-ZА-Я0-9 ./-]{2,40}?)(?=\s+3\.)/imu);
    if (registration) {
      if (!data.vehicle_plate) {
        const value = clean(registration[1]);
        data.vehicle_plate = value;
        evidence.vehicle_plate = { label: "Госномер автомобиля", value, confidence: 0.75 };
      }
      if (!data.vehicle_make) {
        const value = clean(registration[2]);
        data.vehicle_make = value;
        evidence.vehicle_make = { label: "Марка автомобиля", value, confidence: 0.75 };
      }
    }
  }
  for (const [field, label, expressions] of datePatterns) {
    for (const expression of expressions) {
      const match = expression.exec(text);
      if (!match?.[1]) continue;
      const value = isoDate(match[1]);
      data[field] = value;
      evidence[field] = { label, value, confidence: 0.9 };
      break;
    }
  }
  if (isElectronicInvoice(text)) {
    // The electronic invoice is a fixed form: its boxes are more reliable than free-text patterns.
    const esf = parseElectronicInvoice(text);
    for (const [field, value] of Object.entries(esf.data)) {
      if (!sourceFieldKeys.has(field)) continue;
      data[field] = value;
      evidence[field] = { label: SOURCE_FIELD_DEFINITIONS.find(item => item.key === field)?.label ?? field, value, confidence: 0.95 };
    }
    if (esf.items.length) data.invoice_items = esf.items;
  }
  return { data, evidence, conflicts: [] };
}

// Letters that look alike in Latin and Cyrillic: OCR and keyboards mix them freely in plates.
const HOMOGLYPHS: Record<string, string> = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X" };
const PLATE_FIELDS = new Set(["vehicle_plate", "trailer_plate"]);
const PHONE_FIELDS = new Set(["driver_phone", "seller_phone"]);

/** The key under which two values count as the same fact. */
export function comparableValue(field: string, value: string) {
  if (PLATE_FIELDS.has(field)) return [...value.toLocaleUpperCase("ru-RU")].map(character => HOMOGLYPHS[character] ?? character).join("").replace(/[^A-Z0-9]/g, "");
  if (PHONE_FIELDS.has(field)) return value.replace(/\D/g, "").slice(-10);
  return value.toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}

export function conflictsAcrossDocuments(results: Array<{ documentId: string; result: ExtractionResult }>) {
  const values = new Map<string, Map<string, { shown: string; documents: string[] }>>();
  for (const { documentId, result } of results) {
    for (const [field, raw] of Object.entries(result.data)) {
      if (raw === null || typeof raw === "object") continue;
      const value = String(raw).trim();
      if (!value) continue;
      const key = comparableValue(field, value);
      if (!key) continue;
      const byValue = values.get(field) ?? new Map<string, { shown: string; documents: string[] }>();
      const entry = byValue.get(key) ?? { shown: value, documents: [] };
      entry.documents.push(documentId);
      byValue.set(key, entry);
      values.set(field, byValue);
    }
  }
  const conflicts: ExtractionConflict[] = [];
  for (const [field, byValue] of values) {
    if (byValue.size < 2) continue;
    conflicts.push({ field, values: [...byValue.values()].map(entry => entry.shown), documents: [...new Set([...byValue.values()].flatMap(entry => entry.documents))] });
  }
  return conflicts;
}

/** Facts about one vehicle (or one vehicle's papers). Everything else describes the shipment as a whole. */
export const VEHICLE_SCOPED_FIELDS = [
  "carrier_name", "vehicle_plate", "vehicle_make", "trailer_plate", "trailer_make", "driver_name", "driver_phone", "driver_document",
  "temperature_setpoint", "seals", "cmr_number", "ttn_number", "waybill_number", "packing_list_number", "shipping_date",
  "pallet_count", "gross_weight_kg", "net_weight_kg",
] as const;
const vehicleScoped = new Set<string>(VEHICLE_SCOPED_FIELDS);

export type ConfirmedSource = { data: Record<string, unknown>; transportId?: string | null };

/**
 * Overlays confirmed source values for ONE vehicle. Shipment-level facts come from every source. A vehicle fact is
 * taken only from a source bound to that vehicle; in a shipment with a single vehicle an unbound source counts as
 * its own (the earlier behaviour). With several vehicles an unbound source is never guessed onto a vehicle: its
 * vehicle fields are reported in `unassigned_vehicle_fields` so the employee can bind the document.
 */
export function mergeConfirmedSources(
  base: Record<string, unknown>,
  sources: ConfirmedSource[],
  scope: { transportId?: string | null; transportCount: number },
) {
  const own: Record<string, unknown>[] = [];
  const skipped = new Set<string>();
  const filtered = sources.map(source => {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source.data)) {
      if (!vehicleScoped.has(key)) { data[key] = value; continue; }
      const bound = source.transportId ?? null;
      const applies = bound ? bound === scope.transportId : scope.transportCount <= 1;
      if (applies) data[key] = value;
      else if (!bound && value !== null && value !== "" && value !== undefined) skipped.add(key);
    }
    return data;
  });
  for (const data of filtered) own.push(data);
  const merged = mergeConfirmedSourceData(base, own);
  if (skipped.size) merged.unassigned_vehicle_fields = [...skipped];
  return merged;
}

export function mergeConfirmedSourceData(base: Record<string, unknown>, sources: Array<Record<string, unknown>>) {
  const merged = { ...base };
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === "" || value === undefined) continue;
      if (key === "items" && Array.isArray(value) && value.length) merged.items = value;
      else merged[key] = value;
    }
  }
  const transports = Array.isArray(merged.transports) ? [...merged.transports] as Array<Record<string, unknown>> : [];
  if (transports.length) {
    transports[0] = {
      ...transports[0],
      carrier_name: merged.carrier_name || transports[0].carrier_name,
      vehicle_plate: merged.vehicle_plate || transports[0].vehicle_plate,
      vehicle_make: merged.vehicle_make || transports[0].vehicle_make,
      trailer_plate: merged.trailer_plate || transports[0].trailer_plate,
      trailer_make: merged.trailer_make || transports[0].trailer_make,
      driver_name: merged.driver_name || transports[0].driver_name,
      driver_phone: merged.driver_phone || transports[0].driver_phone,
      driver_document: merged.driver_document || transports[0].driver_document,
      temperature_setpoint: merged.temperature_setpoint || transports[0].temperature_setpoint,
    };
    merged.transports = transports;
  }
  return merged;
}
