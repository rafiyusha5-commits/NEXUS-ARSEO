import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentDataSource, ShipmentRow } from "../types.ts";

// Reads with the employee's own session client: RLS and column grants apply to every query.
// Each query names its columns; price columns, driver data and file contents are never selected.
// (Extraction JSON is read whole on the server and reduced to an allow-list by the tool.)

class DataError extends Error {
  constructor() {
    super("DATA_ERROR");
    this.name = "DataError";
  }
}

function ensure<T>(result: { data: T | null; error: unknown; count?: number | null }): { data: T; count: number | null } {
  if (result.error) throw new DataError();
  return { data: (result.data ?? []) as T, count: result.count ?? null };
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function partyName(value: unknown): string | null {
  const party = one(value as { short_name?: string | null; legal_name?: string | null } | null);
  return party ? party.short_name || party.legal_name || null : null;
}

/** PostgREST filter values: keep the validated search characters, drop filter syntax. */
function searchTerm(value: string): string {
  return value.replace(/[.,()"'\\%*:]/g, " ").replace(/\s+/g, " ").trim();
}

export function createSupabaseAgentData(supabase: SupabaseClient): AgentDataSource {
  return {
    async findShipments({ query, status, type, date, dateKind = "any", limit }, signal) {
      const load = async (kind: "ready" | "arrival" | "loading" | "any"): Promise<{ rows: ShipmentRow[]; total: number | null }> => {
      let request = supabase.from("shipments")
        .select("id,created_at,shipment_number,project_code,type,status,planned_ready_date,planned_arrival_date,supplier:counterparties!shipments_supplier_id_fkey(short_name,legal_name),customer:counterparties!shipments_customer_id_fkey(short_name,legal_name)" + (date && kind === "loading" ? ",transports:shipment_transports!inner(planned_loading_date)" : ""), { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(date && dateKind === "any" ? limit + 1 : limit)
        .abortSignal(signal);
      if (status) request = request.eq("status", status);
      if (type) request = request.eq("type", type);
      const term = query ? searchTerm(query) : "";
      const textFilter = `shipment_number.ilike.%${term}%,project_code.ilike.%${term}%`;
      if (term && !(date && kind === "any")) request = request.or(textFilter);
      if (date) {
        if (kind === "loading") request = request.eq("transports.planned_loading_date", date);
        else if (kind === "ready") request = request.eq("planned_ready_date", date);
        else if (kind === "arrival") request = request.eq("planned_arrival_date", date);
        else {
          const dateFilter = `planned_ready_date.eq.${date},planned_arrival_date.eq.${date}`;
          request = request.or(term ? `and(or(${textFilter}),or(${dateFilter}))` : dateFilter);
        }
      }
      const { data, count } = ensure(await request);
      return { rows: (data as unknown as ShipmentRow[]).map((row) => ({ ...row, supplier_name: partyName(row.supplier), customer_name: partyName(row.customer),
        matched_date_kind: date ? [row.planned_ready_date === date && "Готовность", row.planned_arrival_date === date && "Прибытие", kind === "loading" && "Загрузка машины"].filter(Boolean).join(", ") : null })), total: count };
      };
      if (!date || dateKind !== "any") return load(dateKind);
      const groups = await Promise.all([load("any"), load("loading")]);
      const unique = new Map<string, ShipmentRow>();
      for (const group of groups) for (const row of group.rows) {
        const previous = unique.get(String(row.id));
        unique.set(String(row.id), previous ? { ...previous, matched_date_kind: [...new Set(`${previous.matched_date_kind}, ${row.matched_date_kind}`.split(", "))].join(", ") } : row);
      }
      const rows = [...unique.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { rows: rows.slice(0, limit + 1), total: groups.every(group => group.total !== null && group.total === group.rows.length) ? rows.length : null };
    },

    async getShipment(id, signal) {
      const { data, error } = await supabase.from("shipments")
        .select("id,shipment_number,project_code,type,status,planned_ready_date,planned_arrival_date,hold_reason,cancel_reason,supplier:counterparties!shipments_supplier_id_fkey(short_name,legal_name),customer:counterparties!shipments_customer_id_fkey(short_name,legal_name),route:routes(name),responsible:profiles!shipments_responsible_user_id_fkey(full_name)")
        .eq("id", id).abortSignal(signal).maybeSingle();
      if (error) throw new DataError();
      if (!data) return null;
      const row = data as ShipmentRow;
      return { ...row, supplier_name: partyName(row.supplier), customer_name: partyName(row.customer), route_name: one(row.route as { name?: unknown } | null)?.name ?? null, responsible_name: one(row.responsible as { full_name?: unknown } | null)?.full_name ?? null };
    },

    async getShipmentStages(id, signal) {
      const { data } = ensure(await supabase.from("shipment_stage_runs").select("status,status_reason,stage:shipment_stages(name,sequence_order)").eq("shipment_id", id).limit(200).abortSignal(signal));
      return (data as ShipmentRow[]).map((row) => {
        const stage = one(row.stage as { name?: unknown; sequence_order?: number } | null);
        return { status: row.status, status_reason: row.status_reason, stage_name: stage?.name ?? null, sequence_order: stage?.sequence_order ?? null };
      }).sort((a, b) => Number(a.sequence_order ?? 0) - Number(b.sequence_order ?? 0));
    },

    async getShipmentItems(id, limit, signal) {
      const { data, count } = ensure(await supabase.from("shipment_items")
        .select("id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,product:products(internal_sku,name)", { count: "exact" })
        .eq("shipment_id", id).order("created_at").limit(limit).abortSignal(signal));
      return {
        rows: (data as ShipmentRow[]).map((row) => {
          const product = one(row.product as { internal_sku?: unknown; name?: unknown } | null);
          return { ...row, internal_sku: product?.internal_sku ?? null, product_name: product?.name ?? null };
        }),
        total: count,
      };
    },

    async getShipmentVehicles(id, signal) {
      const { data } = ensure(await supabase.from("shipment_transports")
        .select("id,sequence_no,status,vehicle_plate,vehicle_make,trailer_plate,trailer_make,carrier_name,planned_loading_date,actual_loading_date,planned_arrival_date,actual_arrival_date,temperature_setpoint,shipment:shipments(shipment_number)")
        .eq("shipment_id", id).order("sequence_no").limit(21).abortSignal(signal));
      return (data as ShipmentRow[]).map((row) => ({ ...row, shipment_number: one(row.shipment as { shipment_number?: unknown } | null)?.shipment_number ?? null }));
    },

    async getShipmentDocuments(id, signal) {
      const { data: shipment, error } = await supabase.from("shipments").select("id,type,process_template_id,route_id").eq("id", id).abortSignal(signal).maybeSingle();
      if (error) throw new DataError();
      if (!shipment) return { documents: [], missingTypes: [] };
      const [transports, stages, requirements] = await Promise.all([
        supabase.from("shipment_transports").select("id,sequence_no").eq("shipment_id", id).limit(50).abortSignal(signal),
        supabase.from("shipment_stage_runs").select("stage_id").eq("shipment_id", id).limit(200).abortSignal(signal),
        supabase.from("document_requirements").select("document_type_id,is_mandatory,shipment_type,process_template_id,route_id,stage_id,type:document_types(name_ru)").eq("is_active", true).eq("is_mandatory", true).limit(200).abortSignal(signal),
      ]);
      const transportRows = ensure(transports).data as Array<{ id: string; sequence_no: number }>;
      const sequence = new Map(transportRows.map((transport) => [transport.id, transport.sequence_no]));
      const { data: links } = ensure(await supabase.from("document_links").select("document_id,entity_type,entity_id")
        .in("entity_type", ["shipment", "shipment_transport"]).in("entity_id", [id, ...sequence.keys()]).is("removed_at", null).limit(200).abortSignal(signal));
      const linkRows = links as Array<{ document_id: string; entity_type: string; entity_id: string }>;
      const ids = [...new Set(linkRows.map((link) => link.document_id))].slice(0, 100);
      const documents = ids.length
        ? ensure(await supabase.from("documents").select("id,title,document_number,status,document_date,valid_until,document_type_id,type:document_types(code,name_ru)")
          .in("id", ids).is("archived_at", null).order("created_at").limit(41).abortSignal(signal)).data as ShipmentRow[]
        : [];
      const rows: ShipmentRow[] = documents.map((document) => {
        const type = one(document.type as { code?: unknown; name_ru?: unknown } | null);
        const vehicleLink = linkRows.find((link) => link.document_id === document.id && link.entity_type === "shipment_transport");
        return { ...document, type_code: type?.code ?? null, type_name: type?.name_ru ?? null, vehicle_sequence_no: vehicleLink ? sequence.get(vehicleLink.entity_id) ?? null : null };
      });
      const stageIds = new Set((ensure(stages).data as Array<{ stage_id: string }>).map((stage) => stage.stage_id));
      const present = new Set(rows.map((row) => row.document_type_id));
      const missing = (ensure(requirements).data as ShipmentRow[]).filter((requirement) =>
        !present.has(requirement.document_type_id)
        && (!requirement.shipment_type || requirement.shipment_type === shipment.type)
        && (!requirement.process_template_id || requirement.process_template_id === shipment.process_template_id)
        && (!requirement.route_id || requirement.route_id === shipment.route_id)
        && (!requirement.stage_id || stageIds.has(String(requirement.stage_id))));
      const missingTypes = [...new Map(missing.map((requirement) => [requirement.document_type_id, { type_name: one(requirement.type as { name_ru?: unknown } | null)?.name_ru ?? null }])).values()];
      return { documents: rows, missingTypes };
    },

    async getExtractions({ shipmentId, documentId, limit }, signal) {
      let request = supabase.from("shipment_source_extractions")
        .select("id,document_id,source_kind,status,extraction_method,extracted_data,confirmed_data,conflicts,document:documents(title)", { count: "exact" })
        .eq("shipment_id", shipmentId).neq("status", "superseded").order("updated_at", { ascending: false }).limit(limit).abortSignal(signal);
      if (documentId) request = request.eq("document_id", documentId);
      const { data, count } = ensure(await request);
      return { rows: (data as ShipmentRow[]).map((row) => ({ ...row, document_title: one(row.document as { title?: unknown } | null)?.title ?? null })), total: count };
    },

    async listDelayedShipments({ today, limit }, signal) {
      const [shipments, vehicles] = await Promise.all([
        supabase.from("shipments").select("id,shipment_number,status,planned_arrival_date", { count: "exact" })
          .not("status", "in", "(closed,cancelled)").lt("planned_arrival_date", today).order("planned_arrival_date").limit(limit).abortSignal(signal),
        supabase.from("shipment_transports").select("id,shipment_id,sequence_no,status,planned_arrival_date,shipment:shipments!inner(shipment_number,status)", { count: "exact" })
          .is("actual_arrival_date", null).not("status", "in", "(arrived,unloaded,cancelled)").not("shipment.status", "in", "(closed,cancelled)")
          .lt("planned_arrival_date", today).order("planned_arrival_date").limit(limit).abortSignal(signal),
      ]);
      const shipmentResult = ensure(shipments);
      const vehicleResult = ensure(vehicles);
      return {
        shipments: shipmentResult.data as ShipmentRow[],
        shipmentTotal: shipmentResult.count,
        vehicles: (vehicleResult.data as ShipmentRow[]).map((row) => ({ ...row, shipment_number: one(row.shipment as { shipment_number?: unknown } | null)?.shipment_number ?? null })),
        vehicleTotal: vehicleResult.count,
      };
    },

    async getStock({ productQuery, warehouseCode, limit }, signal) {
      let request = supabase.from("inventory_fifo_status")
        .select("internal_sku,product_name,brand,warehouse_code,uom,quantity_on_hand,quantity_reserved,quantity_available,expiry_date,shelf_life_state")
        .order("internal_sku").limit(limit).abortSignal(signal);
      if (warehouseCode) request = request.eq("warehouse_code", warehouseCode);
      const term = productQuery ? searchTerm(productQuery) : "";
      if (term) request = request.or(`internal_sku.ilike.%${term}%,brand.ilike.%${term}%,product_name->>ru.ilike.%${term}%`);
      const { data } = ensure(await request);
      return { rows: data as ShipmentRow[], total: null };
    },

    async getMyTasks({ userId, filter, nowIso, limit }, signal) {
      let request = supabase.from("tasks").select("id,title,status,priority,due_at,shipment_id,shipment:shipments(shipment_number)", { count: "exact" })
        .eq("assignee_user_id", userId).order("due_at", { ascending: true, nullsFirst: false }).limit(limit).abortSignal(signal);
      if (filter === "open") request = request.eq("status", "open");
      else if (filter === "in_progress") request = request.eq("status", "in_progress");
      else request = request.in("status", ["open", "in_progress"]);
      if (filter === "overdue") request = request.lt("due_at", nowIso);
      const { data, count } = ensure(await request);
      return { rows: (data as ShipmentRow[]).map((row) => ({ ...row, shipment_number: one(row.shipment as { shipment_number?: unknown } | null)?.shipment_number ?? null })), total: count };
    },
  };
}
