import { readFileSync } from "node:fs";
import { join } from "node:path";

export const fixtureBytes = () => new Uint8Array(readFileSync(join(import.meta.dirname, "..", "fixtures", "export-workbook", "reference-template.xlsx")));

/** Invented shipment items: no real products, prices or barcodes. */
export function makeItems(count: number, overrides: (index: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    product_name: `Тестовый товар ${index + 1}`,
    hs_code: "0000000001",
    supplier_sku: `T-${100 + index}`,
    country_of_origin: "KZ",
    box_barcode: `99999999999${String(index).padStart(2, "0")}`,
    piece_count: 1000 + index * 100,
    box_count: 50,
    pallet_count: 1,
    total_net_weight_kg: (1000 + index * 100) * 0.2,
    total_gross_weight_kg: 300 + index * 10,
    unit_price: 10 + index,
    expiry_date: `2031-0${(index % 9) + 1}-01`,
    ...overrides(index),
  }));
}

export const baseData = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  shipment_number: "SHP-TEST-1",
  order_number: "TEST-ORDER-1",
  order_date: "2030-02-01",
  shipping_date: "2030-02-10",
  driver_name: "Иванов И.И.",
  driver_document: "уд/личн: 111111111",
  vehicle_plate: "111AAA11",
  vehicle_make: "TESTTRUCK",
  trailer_plate: "22BBB22",
  trailer_make: "TESTTRAILER",
  carrier_name: "ТОО «Тест-Перевозчик»",
  ttn_number: "15",
  cmr_number: "16",
  packing_list_number: "17",
  waybill_number: "18",
  esf_number: "19",
  loading_city: "г. Тестоград",
  loading_address: "г. Тестоград, ул. Заводская, 2",
  unloading_address: "Тестландия, г. Город-А, ул. Складская, 5",
  goods_category: "тестовые изделия",
  temperature_setpoint: "+10 - +15",
  seals: "11111111",
  supplier_name: "ТОО «Тест-Продавец»",
  supplier_tax_id: "000000000001",
  supplier_country: "KZ",
  customer_name: "ООО «Тест-Покупатель»",
  customer_tax_id: "0000000002",
  customer_country: "RU",
  contract_number: "T-777",
  contract_date: "2029-12-31",
  incoterms: "DAP",
  items,
  ...extra,
});
