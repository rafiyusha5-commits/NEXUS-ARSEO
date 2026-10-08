// Test doubles for the assistant: no network, no database. The data source deliberately returns
// forbidden columns (prices, driver data, raw OCR) to prove the tools drop them.
import type {
  AgentDataSource, AgentLedger, AgentModelProvider, FinishInput, ModelRequest, ModelResponse, Reservation,
} from "../../src/lib/agent/types.ts";
import { ProviderError } from "../../src/lib/agent/types.ts";
import { DEFAULT_LIMITS } from "../../src/lib/agent/config.ts";

export const SHIPMENT_ID = "11111111-1111-4111-8111-111111111111";
export const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
export const USER_ID = "33333333-3333-4333-8333-333333333333";

/** Values that must never reach the model or the trace. */
export const SECRET_VALUES = {
  purchasePrice: "98765.43",
  esfPrice: "4321.99",
  driverDocument: "045678912",
  driverPhone: "+7 701 555 44 33",
  driverName: "Иванов Иван Иванович",
  documentAmount: "777888.55",
  bankDetails: "KZ12345БИКСЕКРЕТ",
  rawOcr: "СЫРОЙ-ТЕКСТ-OCR-ДОКУМЕНТА",
};

export function fakeData(overrides: Partial<AgentDataSource> = {}): AgentDataSource {
  return {
    async findShipments() {
      return {
        rows: [{
          id: SHIPMENT_ID, shipment_number: "NAR-2026-0007", project_code: "Leib7-x", type: "import", status: "in_transit",
          planned_ready_date: "2026-09-20", planned_arrival_date: "2026-10-05", supplier_name: "Fazer", customer_name: null,
          unit_price: SECRET_VALUES.purchasePrice, base_purchase_price: SECRET_VALUES.purchasePrice,
        }],
        total: 1,
      };
    },
    async getShipment() {
      return {
        id: SHIPMENT_ID, shipment_number: "NAR-2026-0007", project_code: "Leib7-x", type: "import", status: "on_hold",
        planned_ready_date: "2026-09-20", planned_arrival_date: "2026-10-05", supplier_name: "Fazer", customer_name: null,
        route_name: { ru: "Финляндия → Казахстан" }, responsible_name: "Логист",
        hold_reason: `Ждём оплату 15 000 EUR, водитель удостоверение ${SECRET_VALUES.driverDocument}`,
        cancel_reason: "не должно попасть",
      };
    },
    async getShipmentStages() {
      return [
        { status: "completed", stage_name: { ru: "Создание заказа" } },
        { status: "blocked", status_reason: "Нет CMR", stage_name: { ru: "Отгрузка" } },
      ];
    },
    async getShipmentItems() {
      return { rows: [{ internal_sku: "FZ-001", product_name: { ru: "Конфеты" }, uom: "box", ordered_quantity: 120, confirmed_quantity: 120, shipped_quantity: 118, received_quantity: null, unit_price: SECRET_VALUES.purchasePrice }], total: 1 };
    },
    async getShipmentVehicles() {
      return [{
        id: "v1", shipment_number: "NAR-2026-0007", sequence_no: 1, status: "in_transit", vehicle_plate: "123ABC02", vehicle_make: "Volvo", trailer_plate: "45AB02", trailer_make: "Schmitz",
        carrier_name: "Trans", planned_loading_date: "2026-09-25", actual_loading_date: "2026-09-26", planned_arrival_date: "2026-10-05", actual_arrival_date: null,
        temperature_setpoint: "+5", driver_name: SECRET_VALUES.driverName, driver_phone: SECRET_VALUES.driverPhone, driver_document: SECRET_VALUES.driverDocument,
      }];
    },
    async getShipmentDocuments() {
      return {
        documents: [
          { id: DOCUMENT_ID, type_code: "invoice", type_name: "Инвойс", title: "Инвойс поставщика", document_number: "INV-55", status: "approved", document_date: "2026-09-21", amount: SECRET_VALUES.documentAmount, vehicle_sequence_no: null },
          { id: "44444444-4444-4444-8444-444444444444", type_code: "driver_document", type_name: "Документ водителя", title: `Удостоверение ${SECRET_VALUES.driverName}`, document_number: SECRET_VALUES.driverDocument, status: "uploaded", vehicle_sequence_no: 1 },
        ],
        missingTypes: [{ type_name: "CMR" }],
      };
    },
    async getExtractions() {
      return {
        rows: [{
          document_id: DOCUMENT_ID, document_title: "ЭСФ", source_kind: "invoice", status: "needs_review", extraction_method: "ocr",
          extracted_data: {
            invoice_number: "ESF-1", gross_weight_kg: 1520.5, pallet_count: 18, driver_document: SECRET_VALUES.driverDocument,
            driver_phone: SECRET_VALUES.driverPhone, bank_details: SECRET_VALUES.bankDetails, payment_terms: "30 дней",
            invoice_items: [{ product_name: "Конфеты", unit_price: SECRET_VALUES.esfPrice, line_total: "999" }],
          },
          confirmed_data: null,
          field_evidence: { invoice_number: { label: SECRET_VALUES.rawOcr } },
          conflicts: [{ field: "gross_weight_kg" }, { field: "driver_document" }],
        }],
        total: 1,
      };
    },
    async listDelayedShipments() {
      return { shipments: [{ id: SHIPMENT_ID, shipment_number: "NAR-2026-0007", status: "in_transit", planned_arrival_date: "2026-10-01" }], shipmentTotal: 3, vehicles: [], vehicleTotal: 0 };
    },
    async getStock() {
      return { rows: [
        { internal_sku: "FZ-001", product_name: { ru: "Конфеты" }, warehouse_code: "AKT", uom: "box", quantity_on_hand: 10, quantity_reserved: 4, quantity_available: 6, expiry_date: "2026-12-01", shelf_life_state: "warning", unit_landed_cost: SECRET_VALUES.purchasePrice },
        { internal_sku: "FZ-001", product_name: { ru: "Конфеты" }, warehouse_code: "AKT", uom: "box", quantity_on_hand: 5, quantity_reserved: 0, quantity_available: 5, expiry_date: "2026-11-01", shelf_life_state: "critical" },
      ], total: null };
    },
    async getMyTasks(input) {
      return { rows: [{ id: "55555555-5555-4555-8555-555555555555", title: `Проверить CMR, тел. ${SECRET_VALUES.driverPhone}`, status: "open", priority: "high", due_at: "2026-10-06T05:00:00Z", shipment_id: SHIPMENT_ID, shipment_number: "NAR-2026-0007", assignee_seen: input.userId }], total: 1 };
    },
    ...overrides,
  };
}

export type Script = Array<ModelResponse | ProviderError | ((request: ModelRequest) => ModelResponse)>;

export class ScriptedProvider implements AgentModelProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly requests: ModelRequest[] = [];
  private readonly script: Script;
  constructor(script: Script) {
    this.script = [...script];
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest);
    const next = this.script.shift();
    if (!next) throw new ProviderError("AGENT_PROVIDER_ERROR");
    if (next instanceof ProviderError) throw next;
    return typeof next === "function" ? next(request) : next;
  }
  /** Everything the model received, as one string, for leak assertions. */
  seen(): string {
    return JSON.stringify(this.requests);
  }
}

export function toolCall(id: string, name: string, args: Record<string, unknown>, usage = { inputTokens: 1000, outputTokens: 50 }): ModelResponse {
  return { content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage };
}

export function finalAnswer(answer: unknown, usage = { inputTokens: 1500, outputTokens: 200 }): ModelResponse {
  return { content: JSON.stringify(answer), toolCalls: [], usage };
}

export class FakeLedger implements AgentLedger {
  reservations: Array<{ userId: string; channel: string; questionExcerpt: string; reserveUsdMicros: number }> = [];
  finished: FinishInput[] = [];
  reserveError: string | null = null;
  async reserve(input: { userId: string; channel: "web" | "telegram"; questionExcerpt: string; reserveUsdMicros: number }): Promise<Reservation> {
    if (this.reserveError) throw new Error(this.reserveError);
    this.reservations.push(input);
    return { userId: input.userId, runId: "run-1", finishToken: "token", requestsUsed: this.reservations.length, requestLimit: 20 };
  }
  async finish(_reservation: Reservation, input: FinishInput): Promise<void> {
    this.finished.push(input);
  }
}

export const ALL_PERMISSIONS = [
  "agent.use", "shipments.view", "documents.view", "inventory.view", "products.view", "warehouses.view", "tasks.view",
];

export function permissionsOf(codes: string[] | (() => string[])) {
  return async (requested: readonly string[]) => {
    const held = new Set(typeof codes === "function" ? codes() : codes);
    return new Set(requested.filter((code) => held.has(code)));
  };
}

export const TEST_LIMITS = { ...DEFAULT_LIMITS, runDeadlineMs: 10_000, providerTimeoutMs: 5_000 };
export const TEST_PRICING = { inputUsdPerMTok: 2, outputUsdPerMTok: 8 };
