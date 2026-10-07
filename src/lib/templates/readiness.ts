export type ShipmentDocumentReadinessItem = {
  key: string;
  label: string;
  group: "Поставка" | "Контрагенты" | "Товары" | "Перевозка" | "Документы";
  required: boolean;
  ready: boolean;
  source: string;
  tab: "main" | "items" | "delivery" | "documents";
};

const present = (value: unknown) => value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
const rows = (value: unknown) => Array.isArray(value) ? value.filter(row => row && typeof row === "object") as Array<Record<string, unknown>> : [];

export function buildShipmentDocumentReadiness(data: Record<string, unknown>, confirmedSourceFields: string[] = []) {
  const sourceFields = new Set(confirmedSourceFields);
  const source = (key: string, fallback: string) => sourceFields.has(key) ? "Подтверждённый загруженный документ" : fallback;
  const items = rows(data.items);
  const transports = rows(data.transports);
  const everyItem = (keys: string[]) => items.length > 0 && items.every(item => keys.every(key => present(item[key])));
  const firstTransport = transports[0] ?? {};
  const value = (key: string) => present(data[key]) ? data[key] : firstTransport[key];
  const list: ShipmentDocumentReadinessItem[] = [
    { key: "shipment_number", label: "Номер поставки", group: "Поставка", required: true, ready: present(data.shipment_number), source: "Карточка поставки", tab: "main" },
    { key: "planned_ready_date", label: "Дата готовности или отгрузки", group: "Поставка", required: false, ready: present(data.shipping_date) || present(data.planned_ready_date) || present(firstTransport.planned_loading_date), source: source("shipping_date", "Карточка поставки"), tab: "main" },
    { key: "supplier_name", label: "Поставщик", group: "Контрагенты", required: true, ready: present(data.supplier_name), source: "Справочник поставщиков", tab: "main" },
    { key: "customer_name", label: "Получатель товара", group: "Контрагенты", required: data.shipment_type !== "import", ready: present(data.customer_name) || data.shipment_type === "import", source: present(data.customer_name) ? "Карточка поставки" : "Эталонная экспортная книга", tab: "main" },
    { key: "items", label: "Товарные позиции", group: "Товары", required: true, ready: items.length > 0, source: "Вкладка «Товары»", tab: "items" },
    { key: "item_identifiers", label: "Артикулы и штрихкоды товаров", group: "Товары", required: false, ready: everyItem(["supplier_sku"]) && items.every(item => present(item.gtin) || present(item.unit_barcode)), source: "Карточки товаров", tab: "items" },
    { key: "item_customs", label: "Коды ТН ВЭД и страны происхождения", group: "Товары", required: false, ready: everyItem(["hs_code", "country_of_origin"]), source: "Карточки товаров", tab: "items" },
    { key: "item_load", label: "Количество штук, коробов и паллет", group: "Товары", required: true, ready: everyItem(["piece_count", "box_count", "pallet_count"]), source: "Упаковка товаров", tab: "items" },
    { key: "item_weights", label: "Вес нетто и брутто", group: "Товары", required: true, ready: everyItem(["total_net_weight_kg", "total_gross_weight_kg"]), source: "Упаковка товаров", tab: "items" },
    { key: "transports", label: "Автомобиль поставки", group: "Перевозка", required: true, ready: transports.length > 0, source: "Вкладка «Доставка»", tab: "delivery" },
    { key: "vehicle_plate", label: "Госномер автомобиля", group: "Перевозка", required: true, ready: present(value("vehicle_plate")), source: source("vehicle_plate", "Карточка автомобиля"), tab: "delivery" },
    { key: "trailer_plate", label: "Госномер прицепа", group: "Перевозка", required: false, ready: present(value("trailer_plate")), source: source("trailer_plate", "Карточка автомобиля"), tab: "delivery" },
    { key: "driver_name", label: "Водитель", group: "Перевозка", required: true, ready: present(value("driver_name")), source: source("driver_name", "Карточка перевозки"), tab: "delivery" },
    { key: "carrier_name", label: "Перевозчик", group: "Перевозка", required: true, ready: present(value("carrier_name")), source: source("carrier_name", "Карточка перевозки"), tab: "delivery" },
    { key: "temperature_setpoint", label: "Температурный режим", group: "Перевозка", required: false, ready: present(value("temperature_setpoint")), source: source("temperature_setpoint", "Карточка перевозки"), tab: "delivery" },
    { key: "loading_address", label: "Адрес загрузки", group: "Перевозка", required: true, ready: present(data.loading_address), source: source("loading_address", "Подтверждённые документы"), tab: "documents" },
    { key: "unloading_address", label: "Адрес выгрузки", group: "Перевозка", required: true, ready: present(data.unloading_address) || present(data.destination_address), source: source("unloading_address", "Склад назначения"), tab: "documents" },
    { key: "invoice_number", label: "Номер инвойса", group: "Документы", required: false, ready: present(data.invoice_number), source: source("invoice_number", "Исходные документы"), tab: "documents" },
    { key: "order_number", label: "Номер заказа", group: "Документы", required: false, ready: present(data.order_number) || present(data.project_code), source: source("order_number", "Карточка поставки"), tab: "documents" },
  ];
  return {
    items: list,
    requiredMissing: list.filter(item => item.required && !item.ready).length,
    recommendedMissing: list.filter(item => !item.required && !item.ready).length,
    ready: list.every(item => !item.required || item.ready),
  };
}
