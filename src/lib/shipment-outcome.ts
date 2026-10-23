import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildBatchOutcomes, countFindings, summarizeOutcomes,
  type BatchOutcome, type DocumentCheckFinding, type OutcomeBalance, type OutcomeBatch, type OutcomeMovement, type OutcomeReservation,
} from "@/lib/shipment-outcome-rules";

// The second half of the shipment report: what happened to the goods after receiving. Every block is read
// with the employee's own rights; a block the employee may not see is reported as hidden, not as empty.

const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export type OutcomeCost = {
  version: number; status: string; approvedAt: string | null; currency: string | null;
  goodsTotal: number; expensesTotal: number; landedTotal: number;
  items: Array<{ shipmentItemId: string; quantity: number; costQuantity?: number; landedAmount: number; unitLandedCost: number }>;
};
export type OutcomeShelfLife = { batchId: string; state: string; firstDeadline: string | null };

export type ShipmentOutcome = {
  today: string;
  inventoryVisible: boolean;
  salesVisible: boolean;
  outcomes: BatchOutcome[];
  products: Map<string, { internal_sku: string; name: string }>;
  summary: ReturnType<typeof summarizeOutcomes>;
  cost: OutcomeCost | null | "hidden";
  documentCheck: { lastRunAt: string | null; findings: DocumentCheckFinding[]; counts: ReturnType<typeof countFindings> } | "hidden";
  shelfLife: OutcomeShelfLife[] | "hidden";
};

export async function loadShipmentOutcome(supabase: SupabaseClient, shipmentId: string, itemIds: readonly string[], granted: ReadonlySet<string>): Promise<ShipmentOutcome> {
  const day = today();
  const inventoryVisible = granted.has("inventory.view");
  const salesVisible = granted.has("sales.view");
  const costVisible = granted.has("costing.view") && granted.has("prices.purchase.view");

  const { data: batchRows } = inventoryVisible && itemIds.length
    ? await supabase.from("inventory_batches").select("id,batch_number,product_id,manufacture_date,expiry_date,status,product:products(internal_sku,name,shelf_life_days)").in("source_shipment_item_id", [...itemIds]).order("expiry_date")
    : { data: [] };
  const rawBatches = (batchRows ?? []) as Array<Omit<OutcomeBatch, "shelf_life_days"> & { product: unknown }>;
  const products = new Map<string, { internal_sku: string; name: string }>();
  const batches: OutcomeBatch[] = rawBatches.map(row => {
    const product = one(row.product as { internal_sku?: string; name?: Record<string, string>; shelf_life_days?: number | null } | null);
    products.set(row.product_id, { internal_sku: product?.internal_sku ?? "", name: product?.name?.ru ?? product?.name?.en ?? "" });
    return { id: row.id, batch_number: row.batch_number, product_id: row.product_id, manufacture_date: row.manufacture_date, expiry_date: row.expiry_date, status: row.status, shelf_life_days: product?.shelf_life_days ?? null };
  });
  const batchIds = batches.map(batch => batch.id);

  const [balanceResult, movementResult, reservationResult, costResult, checkResult, shelfResult] = await Promise.all([
    batchIds.length ? supabase.from("inventory_balances").select("batch_id,uom,quantity_on_hand,quantity_reserved").in("batch_id", batchIds) : Promise.resolve({ data: [] }),
    batchIds.length ? supabase.from("inventory_movements").select("batch_id,movement_type,quantity,uom,from_warehouse_id,to_warehouse_id").in("batch_id", batchIds) : Promise.resolve({ data: [] }),
    batchIds.length && salesVisible
      ? supabase.from("inventory_reservations").select("batch_id,quantity,status,balance:inventory_balances(uom),sale_item:sale_items(sale:sales(id,sale_number,status,customer:counterparties(short_name,legal_name)))").in("batch_id", batchIds)
      : Promise.resolve({ data: [] }),
    costVisible
      ? supabase.from("cost_calculations").select("version_number,status,approved_at,goods_total,expenses_total,landed_total,currency:currencies(code),items:cost_calculation_items(shipment_item_id,quantity,cost_quantity,landed_amount,unit_landed_cost)").eq("shipment_id", shipmentId).in("status", ["approved", "draft"]).order("status", { ascending: true }).order("version_number", { ascending: false }).limit(1)
      : Promise.resolve({ data: null }),
    granted.has("documents.view") ? supabase.rpc("shipment_document_check", { p_shipment_id: shipmentId }) : Promise.resolve({ data: null, error: { message: "hidden" } }),
    inventoryVisible && granted.has("products.view") && batchIds.length ? supabase.rpc("shelf_life_risks", { p_horizon_days: 60 }) : Promise.resolve({ data: null, error: batchIds.length ? { message: "hidden" } : null }),
  ]);

  const reservations: OutcomeReservation[] = ((reservationResult.data ?? []) as Array<{ batch_id: string; quantity: number | string; status: string; balance: unknown; sale_item: unknown }>).map(row => {
    const sale = one(one(row.sale_item as { sale: unknown } | null)?.sale as { id: string; sale_number: string; status: string; customer: unknown } | null);
    const customer = one(sale?.customer as { short_name?: string | null; legal_name?: string | null } | null);
    return {
      batch_id: row.batch_id, quantity: row.quantity, status: row.status,
      uom: one(row.balance as { uom?: string } | null)?.uom ?? null,
      sale: sale ? { id: sale.id, sale_number: sale.sale_number, status: sale.status, customer_name: customer?.short_name || customer?.legal_name || null } : null,
    };
  });
  const outcomes = buildBatchOutcomes(batches, (balanceResult.data ?? []) as OutcomeBalance[], (movementResult.data ?? []) as OutcomeMovement[], reservations, day);

  // The approved calculation is the cost of the shipment; a newer draft is shown only when nothing is approved.
  let cost: ShipmentOutcome["cost"] = costVisible ? null : "hidden";
  if (costVisible) {
    const calculations = (costResult.data ?? []) as Array<{ version_number: number; status: string; approved_at: string | null; goods_total: number | string; expenses_total: number | string; landed_total: number | string; currency: unknown; items: Array<{ shipment_item_id: string; quantity: number | string; cost_quantity?: number | string | null; landed_amount: number | string; unit_landed_cost: number | string }> }>;
    const chosen = calculations.find(row => row.status === "approved") ?? calculations[0];
    if (chosen) cost = {
      version: chosen.version_number, status: chosen.status, approvedAt: chosen.approved_at, currency: one(chosen.currency as { code?: string } | null)?.code ?? null,
      goodsTotal: Number(chosen.goods_total), expensesTotal: Number(chosen.expenses_total), landedTotal: Number(chosen.landed_total),
      items: (chosen.items ?? []).map(item => ({ shipmentItemId: item.shipment_item_id, quantity: Number(item.quantity), costQuantity: Number(item.cost_quantity ?? item.quantity), landedAmount: Number(item.landed_amount), unitLandedCost: Number(item.unit_landed_cost) })),
    };
  }

  const check = checkResult.error || !checkResult.data ? "hidden" as const : (() => {
    const data = checkResult.data as { last_run_at?: string | null; findings?: DocumentCheckFinding[] };
    const findings = Array.isArray(data.findings) ? data.findings : [];
    return { lastRunAt: data.last_run_at ?? null, findings, counts: countFindings(findings) };
  })();

  const shelfLife = shelfResult.error ? "hidden" as const : (((shelfResult.data as { items?: Array<{ batch_id: string; state: string; first_deadline: string | null }> } | null)?.items ?? [])
    .filter(item => batchIds.includes(item.batch_id))
    .map(item => ({ batchId: item.batch_id, state: item.state, firstDeadline: item.first_deadline })));

  return { today: day, inventoryVisible, salesVisible, outcomes, products, summary: summarizeOutcomes(outcomes), cost, documentCheck: check, shelfLife };
}
