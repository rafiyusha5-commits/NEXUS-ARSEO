export function canViewShipmentPrices(grantedPermissions: ReadonlySet<string>) {
  return grantedPermissions.has("prices.purchase.view");
}

export type RequirementRule = {
  document_type_id: string;
  is_mandatory: boolean;
  /** "shipment" (default) or "shipment_transport": then every vehicle needs its own document. */
  applies_to?: string | null;
  shipment_type?: string | null;
  process_template_id?: string | null;
  route_id?: string | null;
  stage_id?: string | null;
};
export type RequirementContext = {
  shipment: { type: string; process_template_id?: string | null; route_id?: string | null };
  /** Stages of the shipment's process: a requirement of another process's stage does not apply. */
  stageIds: ReadonlySet<string>;
  documents: Array<{ id: string; document_type_id: string; status?: string | null }>;
  links: Array<{ document_id: string; entity_type: string; entity_id: string }>;
  transports: Array<{ id: string; sequence_no: number; status: string }>;
};
export type MissingRequiredDocument<R> = { requirement: R; transport: { id: string; sequence_no: number } | null };

/**
 * Mandatory documents that are missing, the same way as the «Сверка» agent counts them: a shipment
 * requirement is met by a document of that type linked to the shipment or one of its vehicles; a vehicle
 * requirement must be met for every vehicle that is not cancelled, by a document linked to that vehicle,
 * or to the shipment when it has only one vehicle. Rejected documents do not count.
 */
export function missingRequiredDocuments<R extends RequirementRule>(requirements: R[], context: RequirementContext): MissingRequiredDocument<R>[] {
  const { shipment, stageIds } = context;
  const applicable = requirements.filter((requirement) =>
    requirement.is_mandatory
    && (!requirement.shipment_type || requirement.shipment_type === shipment.type)
    && (!requirement.process_template_id || requirement.process_template_id === shipment.process_template_id)
    && (!requirement.route_id || requirement.route_id === shipment.route_id)
    && (!requirement.stage_id || stageIds.has(requirement.stage_id)));
  const typeOf = new Map(context.documents.filter((document) => document.status !== "rejected").map((document) => [document.id, document.document_type_id]));
  const vehicles = context.transports.filter((transport) => transport.status !== "cancelled").sort((a, b) => a.sequence_no - b.sequence_no);
  const vehicleIds = new Set(vehicles.map((vehicle) => vehicle.id));
  const linked = context.links.filter((link) => typeOf.has(link.document_id)
    && (link.entity_type === "shipment" || (link.entity_type === "shipment_transport" && vehicleIds.has(link.entity_id))));
  const has = (typeId: string, test: (link: RequirementContext["links"][number]) => boolean) =>
    linked.some((link) => typeOf.get(link.document_id) === typeId && test(link));

  const seen = new Set<string>();
  const missing: MissingRequiredDocument<R>[] = [];
  for (const requirement of applicable) {
    const perVehicle = requirement.applies_to === "shipment_transport";
    const key = `${requirement.document_type_id}:${perVehicle ? "vehicle" : "shipment"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!perVehicle) {
      if (!has(requirement.document_type_id, () => true)) missing.push({ requirement, transport: null });
      continue;
    }
    for (const vehicle of vehicles) {
      const present = has(requirement.document_type_id, (link) =>
        (link.entity_type === "shipment_transport" && link.entity_id === vehicle.id) || (link.entity_type === "shipment" && vehicles.length === 1));
      if (!present) missing.push({ requirement, transport: { id: vehicle.id, sequence_no: vehicle.sequence_no } });
    }
  }
  return missing;
}
