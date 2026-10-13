// Where the batches of a shipment went: received, sold or issued, written off, on hand and reserved, per batch
// and unit, and whether the movements explain the balance. Pure functions over rows read under RLS.

export type OutcomeBatch = { id: string; batch_number: string; product_id: string; manufacture_date: string | null; expiry_date: string; status: string; shelf_life_days: number | null };
export type OutcomeBalance = { batch_id: string; uom: string; quantity_on_hand: number | string; quantity_reserved: number | string };
export type OutcomeMovement = { batch_id: string; movement_type: string; quantity: number | string; uom: string; from_warehouse_id: string | null; to_warehouse_id: string | null };
export type OutcomeReservation = {
  batch_id: string; quantity: number | string; uom?: string | null; status: string;
  sale: { id: string; sale_number: string; status: string; customer_name: string | null } | null;
};

export type BatchFlow = {
  uom: string;
  received: number; issued: number; writtenOff: number; adjustedIn: number; adjustedOut: number;
  onHand: number; reserved: number;
  /** Received and adjusted in, minus issued, written off and adjusted out, equals the stock on hand. */
  balanced: boolean;
};
export type BatchCustomer = { saleId: string; saleNumber: string; saleStatus: string; customerName: string | null; reserved: number; fulfilled: number; uom: string };
export type BatchOutcome = { batch: OutcomeBatch; flows: BatchFlow[]; customers: BatchCustomer[]; remainingPct: number | null };

const n = (value: number | string | null | undefined) => Number(value ?? 0) || 0;
// Thousandths as integers: sums of numeric(14,3) values without binary drift.
const milli = (value: number) => Math.round(value * 1000);

/** Remaining shelf life on a day, the same formula as private.sale_shelf_life_pct (rounded to 0.01). */
export function remainingShelfLifePct(batch: Pick<OutcomeBatch, "expiry_date" | "manufacture_date" | "shelf_life_days">, today: string) {
  const day = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))) / 86_400_000;
  if (!batch.manufacture_date && batch.shelf_life_days == null) return null;
  const total = batch.manufacture_date ? day(batch.expiry_date) - day(batch.manufacture_date) : Number(batch.shelf_life_days);
  const pct = 100 * (day(batch.expiry_date) - day(today)) / Math.max(1, total);
  return Math.round(Math.min(100, Math.max(0, pct)) * 100) / 100;
}

export function buildBatchOutcomes(
  batches: readonly OutcomeBatch[], balances: readonly OutcomeBalance[], movements: readonly OutcomeMovement[],
  reservations: readonly OutcomeReservation[], today: string,
): BatchOutcome[] {
  return batches.map(batch => {
    const flows = new Map<string, { received: number; issued: number; writtenOff: number; adjustedIn: number; adjustedOut: number; onHand: number; reserved: number }>();
    const flow = (uom: string) => {
      let entry = flows.get(uom);
      if (!entry) { entry = { received: 0, issued: 0, writtenOff: 0, adjustedIn: 0, adjustedOut: 0, onHand: 0, reserved: 0 }; flows.set(uom, entry); }
      return entry;
    };
    for (const movement of movements.filter(item => item.batch_id === batch.id)) {
      const entry = flow(movement.uom);
      const quantity = milli(n(movement.quantity));
      const into = Boolean(movement.to_warehouse_id) && !movement.from_warehouse_id;
      const out = Boolean(movement.from_warehouse_id) && !movement.to_warehouse_id;
      if (movement.movement_type === "receipt" && into) entry.received += quantity;
      else if (movement.movement_type === "issue" && out) entry.issued += quantity;
      else if (movement.movement_type === "write_off" && out) entry.writtenOff += quantity;
      else if (into) entry.adjustedIn += quantity;
      else if (out) entry.adjustedOut += quantity;
      // A transfer between warehouses changes where the stock is, not how much of it there is.
    }
    for (const balance of balances.filter(item => item.batch_id === batch.id)) {
      const entry = flow(balance.uom);
      entry.onHand += milli(n(balance.quantity_on_hand));
      entry.reserved += milli(n(balance.quantity_reserved));
    }
    const customers = new Map<string, BatchCustomer>();
    for (const reservation of reservations.filter(item => item.batch_id === batch.id && item.sale && item.status !== "cancelled")) {
      const sale = reservation.sale!;
      const uom = reservation.uom ?? "";
      const key = `${sale.id}:${uom}`;
      const entry = customers.get(key) ?? { saleId: sale.id, saleNumber: sale.sale_number, saleStatus: sale.status, customerName: sale.customer_name, reserved: 0, fulfilled: 0, uom };
      if (reservation.status === "fulfilled") entry.fulfilled += n(reservation.quantity);
      else entry.reserved += n(reservation.quantity);
      customers.set(key, entry);
    }
    return {
      batch,
      flows: [...flows].map(([uom, entry]) => ({
        uom,
        received: entry.received / 1000, issued: entry.issued / 1000, writtenOff: entry.writtenOff / 1000,
        adjustedIn: entry.adjustedIn / 1000, adjustedOut: entry.adjustedOut / 1000,
        onHand: entry.onHand / 1000, reserved: entry.reserved / 1000,
        balanced: entry.received + entry.adjustedIn - entry.issued - entry.writtenOff - entry.adjustedOut === entry.onHand,
      })),
      customers: [...customers.values()].sort((left, right) => left.saleNumber.localeCompare(right.saleNumber)),
      remainingPct: remainingShelfLifePct(batch, today),
    };
  });
}

export type DocumentCheckFinding = { severity?: string; message?: string; transport_no?: number | null; document_title?: string | null };

/** Totals of the whole shipment for the final summary, per unit. */
export function summarizeOutcomes(outcomes: readonly BatchOutcome[]) {
  const byUnit = new Map<string, { received: number; issued: number; writtenOff: number; onHand: number; reserved: number }>();
  for (const flow of outcomes.flatMap(outcome => outcome.flows)) {
    const entry = byUnit.get(flow.uom) ?? { received: 0, issued: 0, writtenOff: 0, onHand: 0, reserved: 0 };
    entry.received += milli(flow.received); entry.issued += milli(flow.issued); entry.writtenOff += milli(flow.writtenOff);
    entry.onHand += milli(flow.onHand); entry.reserved += milli(flow.reserved);
    byUnit.set(flow.uom, entry);
  }
  return {
    units: [...byUnit].map(([uom, entry]) => ({ uom, received: entry.received / 1000, issued: entry.issued / 1000, writtenOff: entry.writtenOff / 1000, onHand: entry.onHand / 1000, reserved: entry.reserved / 1000 })),
    balanced: outcomes.every(outcome => outcome.flows.every(flow => flow.balanced)),
    batches: outcomes.length,
  };
}

export function countFindings(findings: readonly DocumentCheckFinding[]) {
  return {
    errors: findings.filter(finding => finding.severity === "error").length,
    warnings: findings.filter(finding => finding.severity !== "error").length,
  };
}
