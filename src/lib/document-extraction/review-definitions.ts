import { isSupplierLots } from "./yilmaz.ts";
import { isPackingEvidence } from "./packing-evidence.ts";
import { isCommodityInvoice } from "./commodity-evidence.ts";
import { SOURCE_FIELD_DEFINITIONS } from "./rules.ts";

const fieldsByKind:Record<string,string[]>={
  contract:["contract_number","contract_date","incoterms"],
  invoice:["invoice_number","invoice_date","order_number","order_date","gross_weight_kg","net_weight_kg","pallet_count","incoterms"],
  transport_order:["contract_number","contract_date","carrier_name","driver_name","driver_phone","vehicle_plate","vehicle_make","trailer_plate","trailer_make","loading_address","unloading_address","temperature_setpoint","shipping_date"],
  vehicle_document:["vehicle_plate","vehicle_make","trailer_plate","trailer_make"],
  driver_document:["driver_name","driver_document","driver_phone"],
  waybill:["waybill_number","cmr_number","ttn_number","shipping_date","vehicle_plate","trailer_plate","driver_name","gross_weight_kg","net_weight_kg","pallet_count"],
  specification:["packing_list_number","order_number","gross_weight_kg","net_weight_kg","pallet_count"],
};
const fieldByKey=new Map(SOURCE_FIELD_DEFINITIONS.map(field=>[field.key,field]));
export function reviewDefinitions(row: { source_kind: string; extracted_data: Record<string, unknown>; confirmed_data: Record<string, unknown> }) {
  const keys = new Set([...(fieldsByKind[row.source_kind] ?? []), ...Object.keys(row.extracted_data ?? {}), ...Object.keys(row.confirmed_data ?? {})]);
  return [...keys].flatMap(key => fieldByKey.get(key) ?? []);
}

export function hasReviewTables(extracted: Record<string, unknown> | null) {
  const data = extracted ?? {};
  const customs = data.customs_record;
  return Boolean(isCommodityInvoice(data.commodity_invoice) || isPackingEvidence(data.packing_evidence)
    || isSupplierLots(data.supplier_lots) || (Array.isArray(data.invoice_items) && data.invoice_items.length > 0)
    || (customs && typeof customs === "object" && "fields" in customs && Array.isArray(customs.fields) && customs.fields.length > 0));
}
