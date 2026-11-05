import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canViewShipmentPrices, missingRequiredDocuments, type MissingRequiredDocument } from "@/lib/shipment-report-rules";

export function localizedName(value: unknown) {
  if (!value || typeof value !== "object") return "—";
  const item = value as Record<string, unknown>;
  return String(item.ru ?? item.en ?? item.kk ?? "—");
}

export function one<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

type Relation<T> = T | T[] | null;
type Localized = { ru?: string; en?: string; kk?: string };
type Party = { legal_name?: string; short_name?: string };
type TransportRef = { sequence_no?: number };
type ProductRef = { internal_sku?: string; name?: Localized; brand?: string };
type DocumentTypeRef = { code: string; name_ru: string | null };
type ProfileRef = { full_name?: string };
type BatchRef = { batch_number?: string; manufacture_date?: string; expiry_date?: string };
type MovementRef = { quantity?: number | string };

export type ReportTransport = { id: string; sequence_no: number; status: string; planned_loading_date?: string | null; actual_loading_date?: string | null; planned_arrival_date?: string | null; actual_arrival_date?: string | null; temperature_setpoint?: string | null; notes?: string | null };
export type ReportStage = { id: string; status: string; status_reason?: string | null; is_required: boolean; started_at?: string | null; completed_at?: string | null; performed_by_name?: string | null; shipment_transport_id?: string | null; stage: Relation<{ id?: string; code?: string; name?: Localized; sequence_order?: number }>; transport: Relation<TransportRef> };
export type ReportItem = { id: string; uom: string; ordered_quantity: number | string; confirmed_quantity?: number | string | null; shipped_quantity?: number | string | null; received_quantity?: number | string | null; unit_price?: number | string | null; discrepancy_reason?: string | null; shipment_transport_id?: string | null; product: Relation<ProductRef>; transport: Relation<TransportRef>; accepted: number; batchQuantity: number; discrepancy: number };
export type ReportReceiptItem = { id?: string; batch_number?: string | null; manufacture_date?: string | null; expiry_date?: string | null; expected_quantity: number | string; accepted_quantity: number | string; damaged_quantity: number | string; shortage_quantity: number | string; overage_quantity: number | string; discrepancy_reason?: string | null; shipment_item_id: string; batch: Relation<BatchRef>; movement: Relation<MovementRef> };
export type ReportReceipt = { id: string; shipment_transport_id: string; performed_by_name: string; notes?: string | null; received_at: string; transport: Relation<TransportRef>; items: ReportReceiptItem[] };
export type ReportDocument = { id: string; title: string; document_number?: string | null; status: string; current_version: number; document_date?: string | null; archived_at?: string | null; document_type_id: string; type: Relation<DocumentTypeRef> };
export type ReportRequirement = { document_type_id: string; is_mandatory: boolean; applies_to?: string | null; due_description?: string | null; shipment_type?: string | null; process_template_id?: string | null; route_id?: string | null; stage_id?: string | null; type: Relation<DocumentTypeRef> };
export type ReportTask = { id: string; title: string; status: string; priority: string; due_at?: string | null; assignee: Relation<ProfileRef> };
export type ReportShipment = { id: string; shipment_number: string; project_code?: string | null; type: string; status: string; planned_ready_date?: string | null; planned_arrival_date?: string | null; created_at: string; process_template_id?: string | null; route_id?: string | null; supplier: Relation<Party>; customer: Relation<Party>; route: Relation<{ name?: Localized }>; warehouse: Relation<{ name?: Localized; code?: string }>; currency: Relation<{ code?: string }>; responsible: Relation<ProfileRef> };

export type ShipmentReport = {
  shipment: ReportShipment;
  transports: ReportTransport[];
  stages: ReportStage[];
  items: ReportItem[];
  receipts: ReportReceipt[];
  documents: ReportDocument[];
  missingDocuments: MissingRequiredDocument<ReportRequirement>[];
  tasks: ReportTask[];
  canViewPrices: boolean;
  totals: { ordered: number; confirmed: number | null; shipped: number | null; accepted: number; batches: number; movements: number; hasReceipt: boolean; reconciled: boolean };
};

export async function loadShipmentReport(supabase: SupabaseClient, shipmentId: string, grantedPermissions: ReadonlySet<string>): Promise<ShipmentReport | null> {
  const { data: shipment, error } = await supabase.from("shipments").select("id,shipment_number,project_code,type,status,planned_ready_date,planned_arrival_date,created_at,process_template_id,route_id,supplier:counterparties!shipments_supplier_id_fkey(legal_name,short_name),customer:counterparties!shipments_customer_id_fkey(legal_name,short_name),route:routes(name),warehouse:warehouses(name,code),currency:currencies(code),responsible:profiles!shipments_responsible_user_id_fkey(full_name)").eq("id", shipmentId).maybeSingle();
  if (error || !shipment) return null;

  const [transportResult, stageResult, itemResult, receiptResult, taskResult, requirementResult] = await Promise.all([
    supabase.from("shipment_transports").select("id,sequence_no,status,planned_loading_date,actual_loading_date,planned_arrival_date,actual_arrival_date,temperature_setpoint,notes").eq("shipment_id", shipmentId).order("sequence_no"),
    supabase.from("shipment_stage_runs").select("id,status,status_reason,is_required,started_at,completed_at,performed_by_name,shipment_transport_id,stage:shipment_stages(id,code,name,sequence_order),transport:shipment_transports(sequence_no)").eq("shipment_id", shipmentId).order("created_at"),
    supabase.from("shipment_items").select("id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,discrepancy_reason,shipment_transport_id,product:products(internal_sku,name,brand),transport:shipment_transports(sequence_no)").eq("shipment_id", shipmentId).order("created_at"),
    supabase.from("shipment_transport_receipts").select("id,shipment_transport_id,performed_by_name,notes,received_at,transport:shipment_transports(sequence_no),items:shipment_transport_receipt_items(id,batch_number,manufacture_date,expiry_date,expected_quantity,accepted_quantity,damaged_quantity,shortage_quantity,overage_quantity,discrepancy_reason,shipment_item_id,batch:inventory_batches(batch_number,manufacture_date,expiry_date),movement:inventory_movements(quantity))").eq("shipment_id", shipmentId).order("received_at"),
    supabase.from("tasks").select("id,title,status,priority,due_at,assignee:profiles!tasks_assignee_user_id_fkey(full_name)").eq("shipment_id", shipmentId).in("status", ["open", "in_progress"]).order("due_at", { nullsFirst: false }),
    supabase.from("document_requirements").select("document_type_id,applies_to,is_mandatory,due_description,shipment_type,process_template_id,route_id,stage_id,type:document_types(code,name_ru)").eq("is_active", true),
  ]);
  const transports = (transportResult.data ?? []) as unknown as ReportTransport[];
  const stages = (stageResult.data ?? []) as unknown as ReportStage[];
  const canViewPrices = canViewShipmentPrices(grantedPermissions);
  const { data: priceRows } = canViewPrices
    ? await supabase.rpc("my_shipment_item_purchase_prices", { p_shipment_id: shipmentId })
    : { data: [] };
  const prices = new Map((priceRows ?? []).map((row: { item_id: string; unit_price: number | string | null }) => [row.item_id, row.unit_price]));
  const rawItems = (itemResult.data ?? []).map((item) => ({ ...item, unit_price: prices.get(item.id) ?? null })) as unknown as Omit<ReportItem, "accepted" | "batchQuantity" | "discrepancy">[];
  const receipts = ((receiptResult.data ?? []) as unknown as ReportReceipt[]).map(receipt => ({...receipt,
    items: receipt.items.map(item => ({...item, batch: item.batch ?? (item.batch_number ? {batch_number:item.batch_number,manufacture_date:item.manufacture_date ?? undefined,expiry_date:item.expiry_date ?? undefined} : null)}))}));

  const targetIds = [shipmentId, ...transports.map((transport) => transport.id)];
  const { data: links } = await supabase.from("document_links").select("document_id,entity_type,entity_id").in("entity_type", ["shipment", "shipment_transport"]).in("entity_id", targetIds).is("removed_at", null);
  const documentIds = [...new Set((links ?? []).map((link) => link.document_id))];
  const { data: documents } = documentIds.length
    ? await supabase.from("documents").select("id,title,document_number,status,current_version,document_date,archived_at,document_type_id,type:document_types(code,name_ru)").in("id", documentIds).is("archived_at", null).order("created_at")
    : { data: [] };

  const receiptItems = receipts.flatMap((receipt) => receipt.items ?? []);
  const items: ReportItem[] = rawItems.map((item) => {
    const related = receiptItems.filter((entry) => entry.shipment_item_id === item.id);
    const accepted = related.reduce((sum, entry) => sum + Number(entry.accepted_quantity ?? 0), 0);
    const batchQuantity = related.filter((entry) => one(entry.batch)).reduce((sum, entry) => sum + Number(entry.accepted_quantity ?? 0), 0);
    return { ...item, accepted, batchQuantity, discrepancy: accepted - Number(item.shipped_quantity ?? item.confirmed_quantity ?? item.ordered_quantity ?? 0) };
  });
  // Shipment and per-vehicle requirements, counted the same way as the «Сверка» agent.
  const missingDocuments = missingRequiredDocuments((requirementResult.data ?? []) as unknown as ReportRequirement[], {
    shipment,
    stageIds: new Set(stages.map((stage) => one(stage.stage)?.id).filter((id): id is string => Boolean(id))),
    documents: (documents ?? []) as Array<{ id: string; document_type_id: string; status: string }>,
    links: (links ?? []) as Array<{ document_id: string; entity_type: string; entity_id: string }>,
    transports,
  });
  const totals = {
    ordered: items.reduce((sum, item) => sum + Number(item.ordered_quantity ?? 0), 0),
    confirmed: items.some(item => item.confirmed_quantity == null) ? null : items.reduce((sum, item) => sum + Number(item.confirmed_quantity), 0),
    shipped: items.some(item => item.shipped_quantity == null) ? null : items.reduce((sum, item) => sum + Number(item.shipped_quantity), 0),
    accepted: items.reduce((sum, item) => sum + item.accepted, 0),
    batches: items.reduce((sum, item) => sum + item.batchQuantity, 0),
    movements: receiptItems.reduce((sum, entry) => sum + Number(one(entry.movement)?.quantity ?? 0), 0),
    hasReceipt: receipts.length > 0,
    reconciled: false,
  };
  totals.reconciled = totals.hasReceipt && totals.accepted === totals.batches && totals.accepted === totals.movements;
  return {
    shipment: shipment as unknown as ReportShipment, transports, stages, items, receipts,
    documents: (documents ?? []) as unknown as ReportDocument[], missingDocuments,
    tasks: (taskResult.data ?? []) as unknown as ReportTask[],
    canViewPrices, totals,
  };
}
