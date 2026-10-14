// What stands between a customer order and its shipment, and how the order page offers to fix it.
// The database checks the same rules again; these helpers only explain them.

export const GUARANTEE_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "Черновик", approved: "Утверждено", sent: "Отправлено", accepted: "Принято клиентом",
  rejected: "Отклонено клиентом", cancelled: "Отменено", superseded: "Заменено",
};

/** Letters that still speak for the order; the others are history. */
export const CURRENT_LETTER_STATUSES: ReadonlySet<string> = new Set(["draft", "approved", "sent", "accepted"]);
/** Letters that confirmation and shipment accept. */
export const FIXED_LETTER_STATUSES: ReadonlySet<string> = new Set(["approved", "sent", "accepted"]);

export type ReservationCheck = {
  batchNumber: string; batchStatus: string | null; expiryDate: string | null;
  remainingPct: number | null; requiredPct: number | null;
};
export type OrderProblem = { kind: "batch_unavailable" | "expired" | "low_shelf_life"; batchNumber: string; text: string };

/** The day the batches must still be good: the planned date, or today once it has passed. */
export function shipmentDay(plannedDate: string, today: string): string {
  return plannedDate > today ? plannedDate : today;
}

export function reservationProblems(reservations: readonly ReservationCheck[], plannedDate: string, today: string, hasFixedLetter: boolean): OrderProblem[] {
  const day = shipmentDay(plannedDate, today);
  const problems: OrderProblem[] = [];
  for (const r of reservations) {
    if (r.batchStatus && r.batchStatus !== "available") {
      const state = r.batchStatus === "blocked" ? "заблокирована" : r.batchStatus === "quarantine" ? "в карантине" : "недоступна";
      problems.push({ kind: "batch_unavailable", batchNumber: r.batchNumber, text: `Партия ${r.batchNumber} ${state}` });
    } else if (r.expiryDate && r.expiryDate < day) {
      problems.push({ kind: "expired", batchNumber: r.batchNumber, text: `Срок годности партии ${r.batchNumber} истекает ${r.expiryDate}, раньше отгрузки` });
    } else if (r.requiredPct !== null && r.remainingPct !== null && r.remainingPct < r.requiredPct && !hasFixedLetter) {
      problems.push({ kind: "low_shelf_life", batchNumber: r.batchNumber,
        text: `ОСГ партии ${r.batchNumber} ${r.remainingPct}% ниже требования клиента ${r.requiredPct}%: нужно утверждённое гарантийное письмо` });
    }
  }
  return problems;
}

/**
 * The ordinary reservation is for draft and reserved orders without a fixed letter. A confirmed order, or one
 * whose letter is already fixed, changes its batches only by re-reservation with a reason.
 */
export function reservationMode(saleStatus: string, hasFixedLetter: boolean): "reserve" | "rereserve" | null {
  if (saleStatus === "confirmed") return "rereserve";
  if (saleStatus === "draft" || saleStatus === "reserved") return hasFixedLetter ? "rereserve" : "reserve";
  return null;
}

export function canReschedule(saleStatus: string): boolean {
  return saleStatus === "draft" || saleStatus === "reserved" || saleStatus === "confirmed";
}

export type Revision = { action: string; reason: string; details: unknown };
type Reserved = { batch_number?: unknown };
function batchList(value: unknown): string {
  const names = Array.isArray(value) ? value.map((row: Reserved) => String(row?.batch_number ?? "")).filter(Boolean) : [];
  return names.length ? [...new Set(names)].join(", ") : "—";
}
function day(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split("-").reverse().join(".") : "—";
}

export function describeRevision(revision: Revision): { title: string; detail: string } {
  const details = (revision.details && typeof revision.details === "object" ? revision.details : {}) as Record<string, unknown>;
  const letter = details.letter_superseded === true ? " Гарантийное письмо заменено." : "";
  if (revision.action === "rereserve") {
    const how = details.fefo === false ? "вручную" : "по FEFO";
    return { title: `Партии заменены ${how}: ${batchList(details.before)} → ${batchList(details.after)}`, detail: `${revision.reason}.${letter}` };
  }
  if (revision.action === "reschedule") {
    const unfit = typeof details.unfit_batches === "string" && details.unfit_batches ? ` Непригодны к новой дате: ${details.unfit_batches}.` : "";
    return { title: `Отгрузка перенесена с ${day(details.from)} на ${day(details.to)}`, detail: `${revision.reason}.${unfit}${letter}` };
  }
  return { title: "Изменение заказа", detail: revision.reason };
}
