// «Логист»: proposals prepared by the database rules and decided by an employee (202609277400).

export type LogistProposal = {
  id: string;
  shipment_id: string;
  kind: string;
  title: string;
  reason: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  shipment: { shipment_number?: string | null; project_code?: string | null } | null;
  decider: { full_name?: string | null } | null;
};

export const KIND_LABEL: Record<string, string> = {
  complete_stage: "Завершить этап",
  bind_document_vehicle: "Привязать документ",
  follow_up_task: "Поставить задачу",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Ждёт решения", accepted: "Принято", rejected: "Отклонено", obsolete: "Неактуально",
};

/** What happens when the employee presses «Принять». */
export const ACCEPT_EFFECT: Record<string, string> = {
  complete_stage: "Этап будет отмечен выполненным от вашего имени.",
  bind_document_vehicle: "Документ будет привязан к автомобилю; данные водителя и машины запишутся при подтверждении документа.",
  follow_up_task: "Будет создана задача на завтра ответственному по поставке (или вам, если вы не можете назначать задачи другим).",
};

const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] ?? null : value ?? null;

/** Rows from PostgREST (relations may come as arrays) → proposals. */
export function parseProposals(rows: readonly Record<string, unknown>[] | null | undefined): LogistProposal[] {
  return (rows ?? []).map(row => ({
    id: String(row.id), shipment_id: String(row.shipment_id), kind: String(row.kind), title: String(row.title),
    reason: String(row.reason), status: String(row.status), created_at: String(row.created_at),
    decided_at: (row.decided_at as string | null) ?? null, decision_note: (row.decision_note as string | null) ?? null,
    shipment: one(row.shipment as LogistProposal["shipment"] | LogistProposal["shipment"][]),
    decider: one(row.decider as LogistProposal["decider"] | LogistProposal["decider"][]),
  }));
}

/** Pending proposals grouped by shipment, the oldest shipment first (it has waited longest). */
export function groupByShipment(proposals: readonly LogistProposal[]) {
  const groups = new Map<string, { shipmentId: string; label: string; proposals: LogistProposal[] }>();
  for (const proposal of [...proposals].sort((left, right) => left.created_at.localeCompare(right.created_at))) {
    const group = groups.get(proposal.shipment_id) ?? {
      shipmentId: proposal.shipment_id,
      label: [proposal.shipment?.shipment_number, proposal.shipment?.project_code].filter(Boolean).join(" · ") || "Поставка",
      proposals: [],
    };
    group.proposals.push(proposal);
    groups.set(proposal.shipment_id, group);
  }
  return [...groups.values()];
}

/** Message after «Принять»: accepted, or the situation has already changed. */
export function acceptMessage(result: unknown) {
  const status = (result as { status?: string } | null)?.status;
  return status === "obsolete"
    ? { kind: "error" as const, text: "Предложение уже неактуально: ситуация изменилась, ничего не сделано." }
    : { kind: "success" as const, text: "Предложение принято и выполнено." };
}

/** Only a page of Nexus, never an outside address, is used to return after a decision. */
export function safeReturnPath(value: unknown) {
  const path = typeof value === "string" ? value : "";
  return /^\/(logist|shipments\/[0-9a-f-]{36})(\?[\w=&%-]*)?$/i.test(path) ? path : "/logist";
}
