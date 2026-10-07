// Declarative map "Nexus field -> sheet -> cell -> format -> source" for the reference workbook
// «Отгрузка заказ HS-41.1 Fazer.xlsx». The filler, the pre-flight check and the documentation
// all read this one list, so they cannot drift apart.

import { contractLabel, partiesLabel, type ExportModel, type ExportOutput } from "./model.ts";

export const SHEETS = {
  input: "данные",
  lines: "для Диляры",
  packing: "упаков.лист",
  cmr: "CMR",
  ttn: "ТТН",
  driver: "фура, водила",
  instruction: "Инструкция",
} as const;

export type FieldKind = "text" | "date" | "number" | "id";

export type FieldSpec = {
  key: string;
  label: string;
  /** Documents that visibly use the value. The full workbook always uses all of them. */
  outputs: ExportOutput[];
  required: boolean;
  kind: FieldKind;
  /** The first target is the input/primary cell; the rest are cells that show the value without a formula. */
  targets: Array<{ sheet: string; cell: string }>;
  source: string;
  read: (model: ExportModel) => string | number | null;
};

const at = (sheet: string, cell: string) => ({ sheet, cell });
const input = (cell: string) => at(SHEETS.input, cell);
const text = (value: string) => value || null;

/** Input cells of sheet «данные»: everything else in the three documents is linked to them by formulas. */
export const INPUT_FIELDS: FieldSpec[] = [
  { key: "orderNumber", label: "Номер заказа", outputs: ["ttn", "packing_list"], required: true, kind: "text", targets: [input("C2")], source: "Карточка поставки / договор-заявка", read: m => text(m.orderNumber) },
  { key: "orderDate", label: "Дата заказа", outputs: [], required: false, kind: "date", targets: [input("C3")], source: "Карточка поставки / договор-заявка", read: m => text(m.orderDate) },
  { key: "shippingDate", label: "Дата отгрузки по документам", outputs: ["cmr", "ttn", "packing_list"], required: true, kind: "date", targets: [input("C4")], source: "Карточка поставки / накладная", read: m => text(m.shippingDate) },
  { key: "driverName", label: "Фамилия и инициалы водителя", outputs: ["ttn", "packing_list"], required: true, kind: "text", targets: [input("C5")], source: "Данные водителя", read: m => text(m.driverName) },
  { key: "driverDocument", label: "Данные по удостоверению водителя", outputs: ["ttn", "packing_list"], required: false, kind: "text", targets: [input("C6")], source: "Данные водителя", read: m => text(m.driverDocument) },
  { key: "vehiclePlate", label: "Гос.номер авто", outputs: ["cmr", "ttn", "packing_list"], required: true, kind: "text", targets: [input("C7")], source: "Данные по автомобилю", read: m => text(m.vehiclePlate) },
  { key: "vehicleMake", label: "Марка авто", outputs: ["cmr", "ttn", "packing_list"], required: false, kind: "text", targets: [input("C8")], source: "Данные по автомобилю", read: m => text(m.vehicleMake) },
  { key: "trailerPlate", label: "Гос.номер прицепа", outputs: ["cmr", "ttn", "packing_list"], required: false, kind: "text", targets: [input("C9")], source: "Данные по прицепу", read: m => text(m.trailerPlate) },
  { key: "trailerMake", label: "Марка прицепа", outputs: ["cmr", "ttn", "packing_list"], required: false, kind: "text", targets: [input("C10")], source: "Данные по прицепу", read: m => text(m.trailerMake) },
  { key: "carrierName", label: "Наименование перевозчика", outputs: ["cmr", "ttn"], required: true, kind: "text", targets: [input("C11"), at(SHEETS.cmr, "H9")], source: "Перевозчик поставки / договор-заявка", read: m => text(m.carrierName) },
  { key: "ttnNumber", label: "ТТН №", outputs: ["ttn"], required: true, kind: "id", targets: [input("C12")], source: "Номер документа (присваивает ARSEO)", read: m => text(m.ttnNumber) },
  { key: "loadingCity", label: "Город погрузки", outputs: ["cmr"], required: false, kind: "text", targets: [input("C13")], source: "Адрес погрузки", read: m => text(m.loadingCity) },
  { key: "loadingCountry", label: "Страна погрузки", outputs: ["cmr"], required: false, kind: "text", targets: [input("C14")], source: "Страна поставщика", read: m => text(m.loadingCountry) },
  { key: "goodsCategory", label: "Категория товаров", outputs: ["cmr", "ttn"], required: false, kind: "text", targets: [input("C15")], source: "Инвойс / карточка товара", read: m => text(m.goodsCategory) },
  { key: "palletCount", label: "Количество паллет", outputs: ["cmr", "ttn"], required: true, kind: "number", targets: [input("C16")], source: "Расчёт по упаковке товаров", read: m => m.palletCount },
  { key: "temperature", label: "Температурный режим", outputs: ["cmr", "ttn"], required: false, kind: "text", targets: [input("C17")], source: "Карточка перевозки", read: m => text(m.temperature) },
  { key: "seals", label: "Номера пломб", outputs: ["ttn"], required: false, kind: "text", targets: [input("C18")], source: "Документы перевозки", read: m => text(m.seals) },
  { key: "unloadingAddress", label: "Пункт разгрузки", outputs: ["cmr", "ttn", "packing_list"], required: true, kind: "text", targets: [input("C19")], source: "Склад назначения / договор-заявка", read: m => text(m.unloadingAddress) },
  { key: "cmrNumber", label: "CMR №", outputs: ["cmr"], required: true, kind: "id", targets: [input("C20")], source: "Номер документа (присваивает ARSEO)", read: m => text(m.cmrNumber) },
  { key: "waybillNumber", label: "Накладная №", outputs: ["cmr"], required: false, kind: "id", targets: [input("C21")], source: "Исходные документы", read: m => text(m.waybillNumber) },
  { key: "esfNumber", label: "ЭСФ №", outputs: ["cmr"], required: false, kind: "id", targets: [input("C22")], source: "Исходные документы", read: m => text(m.esfNumber) },
  { key: "hsCodes", label: "ТНВЭД", outputs: ["cmr"], required: true, kind: "text", targets: [input("C24")], source: "Коды ТН ВЭД товарных позиций", read: m => text(m.hsCodes) },
  { key: "paymentTerms", label: "Условия оплаты", outputs: ["cmr"], required: false, kind: "text", targets: [input("C25")], source: "Договор / Incoterms", read: m => text(m.paymentTerms) },
  { key: "packingListNumber", label: "Упаковочный лист №", outputs: ["packing_list"], required: true, kind: "id", targets: [input("C27")], source: "Номер документа (присваивает ARSEO)", read: m => text(m.packingListNumber) },
  { key: "loadingAddress", label: "Адрес погрузки", outputs: ["ttn", "packing_list"], required: true, kind: "text", targets: [input("C28")], source: "Подтверждённые документы / склад поставщика", read: m => text(m.loadingAddress) },
];

/** Text that the reference workbook has typed straight into document cells (contract, parties, requisites). */
export const BLOCK_FIELDS: FieldSpec[] = [
  { key: "contract", label: "Контракт (номер и дата)", outputs: ["packing_list"], required: true, kind: "text", source: "Договор поставки", read: m => text(contractLabel(m)),
    targets: [at(SHEETS.lines, "C5"), at(SHEETS.driver, "C5"), at(SHEETS.packing, "K4")] },
  { key: "parties", label: "Стороны контракта", outputs: ["packing_list"], required: true, kind: "text", source: "Поставщик и покупатель поставки", read: m => text(partiesLabel(m)),
    targets: [at(SHEETS.lines, "C7"), at(SHEETS.driver, "C7"), at(SHEETS.packing, "K6")] },
  { key: "sellerName", label: "Отправитель / продавец (наименование)", outputs: ["cmr", "ttn", "packing_list"], required: true, kind: "text", source: "Поставщик поставки", read: m => text(m.sellerName),
    targets: [at(SHEETS.cmr, "A3"), at(SHEETS.ttn, "C11"), at(SHEETS.packing, "F23"), at(SHEETS.instruction, "C18")] },
  { key: "sellerAddress", label: "Адрес отправителя", outputs: ["cmr", "ttn"], required: false, kind: "text", source: "Контракт / инвойс", read: m => text(m.sellerAddress),
    targets: [at(SHEETS.cmr, "A4"), at(SHEETS.ttn, "B13")] },
  { key: "sellerCountry", label: "Страна отправителя", outputs: ["cmr"], required: false, kind: "text", source: "Справочник поставщиков", read: m => text(m.sellerCountry), targets: [at(SHEETS.cmr, "A5")] },
  { key: "sellerCorrespondenceAddress", label: "Адрес продавца для корреспонденции", outputs: ["packing_list"], required: false, kind: "text", source: "Контракт / инвойс", read: m => text(m.sellerCorrespondenceAddress), targets: [at(SHEETS.packing, "F24")] },
  { key: "sellerTaxId", label: "БИН продавца", outputs: ["packing_list"], required: false, kind: "text", source: "Справочник поставщиков", read: m => text(m.sellerTaxId), targets: [at(SHEETS.packing, "F25")] },
  { key: "sellerPhone", label: "Телефон продавца", outputs: ["packing_list"], required: false, kind: "text", source: "Контракт / инвойс", read: m => text(m.sellerPhone), targets: [at(SHEETS.packing, "F26"), at(SHEETS.instruction, "C19")] },
  { key: "buyerName", label: "Получатель / покупатель (наименование)", outputs: ["cmr", "ttn", "packing_list"], required: true, kind: "text", source: "Покупатель поставки", read: m => text(m.buyerName),
    targets: [at(SHEETS.cmr, "A9"), at(SHEETS.ttn, "B15"), at(SHEETS.packing, "A23"), at(SHEETS.instruction, "C17")] },
  { key: "buyerAddress", label: "Адрес получателя", outputs: ["cmr"], required: false, kind: "text", source: "Контракт / инвойс", read: m => text(m.buyerAddress), targets: [at(SHEETS.cmr, "A10")] },
  { key: "buyerTaxId", label: "ИНН покупателя", outputs: ["cmr", "packing_list"], required: false, kind: "text", source: "Справочник покупателей", read: m => text(m.buyerTaxId), targets: [at(SHEETS.cmr, "A12"), at(SHEETS.packing, "A25")] },
  { key: "buyerKpp", label: "КПП покупателя", outputs: ["packing_list"], required: false, kind: "text", source: "Контракт / инвойс", read: m => text(m.buyerKpp), targets: [at(SHEETS.packing, "A26")] },
  { key: "unloadingCountry", label: "Страна разгрузки", outputs: ["cmr"], required: false, kind: "text", source: "Страна покупателя", read: m => text(m.unloadingCountry), targets: [at(SHEETS.cmr, "B16")] },
  { key: "bankDetails", label: "Банк-корреспондент продавца (реквизиты)", outputs: ["packing_list"], required: false, kind: "text", source: "Контракт / инвойс", read: m => text(m.bankDetails), targets: [at(SHEETS.packing, "J23")] },
  { key: "senderTitle", label: "Подписант отправителя (ФИО и должность)", outputs: ["ttn"], required: false, kind: "text", source: "Контракт / настройки ARSEO", read: m => text(m.senderTitle), targets: [at(SHEETS.ttn, "B36")] },
];

export type TableColumn = { sheet: string; column: string; label: string; source: string; kind: "text" | "number" | "date" | "formula"; required: boolean; outputs: ExportOutput[] };

/** Columns of the two product tables (rows are produced from shipment items and batches). */
export const TABLE_COLUMNS: TableColumn[] = [
  { sheet: SHEETS.lines, column: "A", label: "№", source: "Порядковый номер позиции", kind: "number", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.lines, column: "B", label: "ТНВЭД", source: "Карточка товара", kind: "text", required: true, outputs: ["cmr"] },
  { sheet: SHEETS.lines, column: "C", label: "Наименование", source: "Карточка товара", kind: "text", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.lines, column: "D", label: "Вес нетто, кг (формула = кол-во × нетто единицы)", source: "Упаковка товара", kind: "formula", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.lines, column: "E", label: "Количество, шт (по партии)", source: "Строка поставки / партия", kind: "number", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.lines, column: "F", label: "Цена", source: "Инвойс (только при включённых ценах)", kind: "number", required: false, outputs: ["cmr", "ttn"] },
  { sheet: SHEETS.lines, column: "G", label: "Сумма (формула = цена × количество)", source: "Расчёт", kind: "formula", required: false, outputs: ["cmr", "ttn"] },
  { sheet: SHEETS.lines, column: "H", label: "Артикул производителя", source: "Идентификаторы товара", kind: "text", required: false, outputs: [] },
  { sheet: SHEETS.lines, column: "I", label: "Срок годности партии", source: "Инвойс / партия", kind: "date", required: false, outputs: [] },
  { sheet: SHEETS.packing, column: "B", label: "Страна происхождения", source: "Карточка товара", kind: "text", required: false, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "C", label: "Штрих-код коробки", source: "Идентификаторы товара", kind: "text", required: false, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "F", label: "Вес нетто чистый (формула)", source: "Упаковка товара", kind: "formula", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "G", label: "Нетто с первичной упаковкой (формула эталона ×1,03)", source: "Формула эталона", kind: "formula", required: false, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "H", label: "Транспортных коробов (формула = шт / штук в коробе)", source: "Упаковка товара", kind: "formula", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "I", label: "Поддонов", source: "Упаковка товара", kind: "number", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "J", label: "Вес брутто, кг", source: "Упаковка товара", kind: "number", required: true, outputs: ["packing_list"] },
  { sheet: SHEETS.packing, column: "K", label: "Брутто с паллетами (формула эталона +25 кг за паллету)", source: "Формула эталона", kind: "formula", required: false, outputs: ["cmr", "ttn", "packing_list"] },
];

export const formatDateForCell = (iso: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
};
