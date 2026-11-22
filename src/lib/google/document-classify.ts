// Suggested document type of a file in a shipment's Drive folder (2026-11-22). Order folders keep their
// documents in subfolders — «Закуп», «Перевозка», «Растаможка» (with «Результат растаможки»), «ЧЗ», «Стикеры».
// The file name decides first; the subfolder only when the name says nothing. A suggestion is never saved by
// itself: the employee sees it preselected and confirms or changes it before upload.

export type TypeSuggestion = { code: string; reason: string };

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е");

// Order matters: the first rule that matches wins.
const NAME_RULES: { code: string; reason: string; pattern: RegExp }[] = [
  { code: "transport_order", reason: "в имени «договор-заявка»", pattern: /договор[\s-]*заявк|заявк[аи]?\s+на\s+перевоз|transport\s*order/ },
  { code: "cmr", reason: "в имени «CMR»", pattern: /(?<![\p{L}])(cmr|смр)(?![\p{L}])/u },
  { code: "certificate", reason: "в имени сертификат или декларация о соответствии", pattern: /сертификат|certificate|декларац\p{L}*\s+о\s+соответстви|(?<![\p{L}])(еаэс|eac)(?![\p{L}])/u },
  { code: "customs_declaration", reason: "в имени «ДТ» или декларация", pattern: /(?<![\p{L}])(дт|гтд)(?![\p{L}])|декларац|declaration/u },
  { code: "packing_list", reason: "в имени упаковочный лист", pattern: /упаковочн|packing/ },
  { code: "specification", reason: "в имени спецификация", pattern: /специфик|specification/ },
  { code: "invoice", reason: "в имени инвойс или счёт", pattern: /инвойс|invoice|proforma|проформ|счет[\s-]*фактур/ },
  { code: "guarantee_letter", reason: "в имени гарантийное письмо", pattern: /гарантийн/ },
  { code: "snt", reason: "в имени «СНТ»", pattern: /(?<![\p{L}])снт(?![\p{L}])/u },
  { code: "ttn", reason: "в имени «ТТН»", pattern: /(?<![\p{L}])ттн(?![\p{L}])/u },
  { code: "waybill", reason: "в имени накладная", pattern: /накладн|waybill/ },
  { code: "marking_codes_file", reason: "в имени коды маркировки", pattern: /(?<![\p{L}])(чз|км)(?![\p{L}])|честн\p{L}*\s+знак|код\p{L}*\s+маркировк/u },
  { code: "sticker_layout", reason: "в имени стикер или макет", pattern: /стикер|sticker|макет/ },
  { code: "vehicle_document", reason: "в имени документ автомобиля", pattern: /техпаспорт|тех\.\s*паспорт|свидетельств\p{L}*\s+о\s+регистрац|(?<![\p{L}])стс(?![\p{L}])/u },
  { code: "driver_document", reason: "в имени документ водителя", pattern: /водител|удостоверени/ },
  { code: "supplier_contract", reason: "в имени контракт", pattern: /контракт|contract|договор\s+поставк/ },
];

// Subfolder names, from the innermost one outwards.
const FOLDER_RULES: { code: string; reason: string; pattern: RegExp }[] = [
  { code: "customs_declaration", reason: "в подпапке «Результат растаможки»", pattern: /результат\p{L}*\s+растаможк/u },
  { code: "marking_codes_file", reason: "в подпапке «ЧЗ»", pattern: /^(чз|честн\p{L}*\s+знак)$/u },
  { code: "sticker_layout", reason: "в подпапке «Стикеры»", pattern: /стикер/ },
];

/** The folders of a scanned file's path ("Растаможка / Результат растаможки / файл.pdf"), innermost first. */
function folders(path: string): string[] {
  const parts = path.split(" / ").map(part => normalize(part.trim())).filter(Boolean);
  return parts.slice(0, -1).reverse();
}

export function suggestDocumentType(path: string, name: string): TypeSuggestion | null {
  const title = normalize(name.replace(/\.[a-z0-9]{2,5}$/i, "")).replace(/[_]+/g, " ");
  for (const rule of NAME_RULES) if (rule.pattern.test(title)) return { code: rule.code, reason: rule.reason };
  for (const folder of folders(path)) for (const rule of FOLDER_RULES) if (rule.pattern.test(folder)) return { code: rule.code, reason: rule.reason };
  return null;
}

/** Files uploaded by one press of «Загрузить выбранные»: each is downloaded and checked in turn. */
export const DRIVE_BATCH_LIMIT = 25;
