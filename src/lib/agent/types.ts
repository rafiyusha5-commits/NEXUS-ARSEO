// Shared types of the assistant. Pure module: no server-only imports, used by Node tests.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type FieldKind = "id" | "text" | "date" | "datetime" | "number" | "status" | "count";

/** One output field of a tool: only listed fields ever leave the server. */
export type ToolField = { key: string; label: string; kind: FieldKind };

/** A row reference the server can turn into a link; never a URL from the model. */
export type EntityRef = { type: "shipment" | "document" | "task"; id: string };

/**
 * One result row. `subject` names the object the row describes (shipment, vehicle, document…); it is
 * built by the tool from the data, so a verified statement never takes its object from the model.
 */
export type ToolRow = { subject: string; values: Record<string, string | number | null>; entity?: EntityRef };

export type ToolResult = {
  rows: ToolRow[];
  /** True when the tool stopped at its row limit: the answer must not claim completeness. */
  truncated: boolean;
  /** Total matching rows when the database reported it. */
  total: number | null;
  /** Statements the server adds verbatim, e.g. that a feature does not exist in Nexus. */
  notes: string[];
};

export type ParamSchema =
  | { type: "date"; optional?: boolean; description: string }
  | { type: "string"; maxLength: number; pattern?: RegExp; optional?: boolean; description: string }
  | { type: "uuid"; optional?: boolean; description: string }
  | { type: "enum"; values: readonly string[]; optional?: boolean; description: string }
  | { type: "integer"; min: number; max: number; optional?: boolean; description: string };

export type ToolContext = {
  userId: string;
  data: AgentDataSource;
  signal: AbortSignal;
};

export type AgentTool = {
  name: string;
  description: string;
  /** Every permission must be held at call time; checked by the server, not by the model. */
  permissions: readonly string[];
  params: Record<string, ParamSchema>;
  fields: readonly ToolField[];
  maxRows: number;
  timeoutMs: number;
  run: (ctx: ToolContext, params: Record<string, string | number>) => Promise<ToolResult>;
};

export type ShipmentRow = Record<string, unknown>;

/**
 * Read access to Nexus data with the employee's own session. Implementations must select only
 * the columns the tools need; tools project the result through their allow-lists again.
 */
export interface AgentDataSource {
  findShipments(input: { query?: string; status?: string; type?: string; date?: string; dateKind?: "ready" | "arrival" | "loading" | "any"; limit: number }, signal: AbortSignal): Promise<{ rows: ShipmentRow[]; total: number | null }>;
  getShipment(id: string, signal: AbortSignal): Promise<ShipmentRow | null>;
  getShipmentStages(id: string, signal: AbortSignal): Promise<ShipmentRow[]>;
  getShipmentItems(id: string, limit: number, signal: AbortSignal): Promise<{ rows: ShipmentRow[]; total: number | null }>;
  getShipmentVehicles(id: string, signal: AbortSignal): Promise<ShipmentRow[]>;
  getShipmentDocuments(id: string, signal: AbortSignal): Promise<{ documents: ShipmentRow[]; missingTypes: ShipmentRow[] }>;
  getExtractions(input: { shipmentId: string; documentId?: string; limit: number }, signal: AbortSignal): Promise<{ rows: ShipmentRow[]; total: number | null }>;
  listDelayedShipments(input: { today: string; limit: number }, signal: AbortSignal): Promise<{ shipments: ShipmentRow[]; shipmentTotal: number | null; vehicles: ShipmentRow[]; vehicleTotal: number | null }>;
  findProducts(input: { query?: string; offset: number; limit: number }, signal: AbortSignal): Promise<{ rows: ShipmentRow[]; total: number | null }>;
  getStock(input: { productQuery?: string; warehouseCode?: string; limit: number }, signal: AbortSignal): Promise<{ rows: ShipmentRow[]; total: number | null }>;
  getMyTasks(input: { userId: string; filter: string; nowIso: string; limit: number }, signal: AbortSignal): Promise<{ rows: ShipmentRow[]; total: number | null }>;
}

export type ModelToolCall = { id: string; name: string; arguments: string };
export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolSpec[];
  /** Final answers must follow ANSWER_JSON_SCHEMA. */
  answerSchema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type ModelResponse = {
  content: string | null;
  toolCalls: ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Counters the provider did not report validly (missing, negative, fractional, not a number).
   * Their value in `usage` is 0 only as a placeholder: the runner charges them conservatively.
   */
  usageMissing?: UsageMissing;
};

export type UsageMissing = { input: boolean; output: boolean };

/** Provider-neutral model interface; channels and business logic never talk to a vendor API. */
export interface AgentModelProvider {
  readonly name: string;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly usage: { inputTokens: number; outputTokens: number };
  /**
   * False when the provider may have processed (and billed) the request but reported no usage:
   * timeouts, lost connections, 5xx, unreadable bodies. The runner then charges a conservative
   * estimate instead of silently treating the call as free.
   */
  readonly usageKnown: boolean;
  /** Which counters are unknown; `usage` holds only the validly reported ones. */
  readonly usageMissing: UsageMissing;
  constructor(code: string, usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 }, known: boolean | UsageMissing = true) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    this.usage = usage;
    this.usageMissing = typeof known === "boolean" ? { input: !known, output: !known } : known;
    this.usageKnown = !this.usageMissing.input && !this.usageMissing.output;
  }
}

export type TraceEntry = {
  name: string;
  params: Record<string, string | number>;
  rows: number;
  truncated: boolean;
  ms: number;
  error?: string;
};

/** userId is the employee the server verified from the session; the run is closed for the same user. */
export type Reservation = { userId: string; runId: string; finishToken: string; requestsUsed: number; requestLimit: number };

export type FinishInput = {
  status: "completed" | "failed" | "rejected";
  errorCode: string | null;
  refund: boolean;
  provider: string;
  model: string;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  actualUsdMicros: number;
  tools: TraceEntry[];
};

/**
 * Atomic accounting in the database (agent_reserve_run / agent_finish_run). Only the trusted server
 * may call it: the RPCs are executable by service_role, never by an employee session.
 */
export interface AgentLedger {
  reserve(input: { userId: string; channel: "web" | "telegram"; questionExcerpt: string; reserveUsdMicros: number }): Promise<Reservation>;
  finish(reservation: Reservation, input: FinishInput): Promise<void>;
}

export type FactValue = { label: string; value: string; field: string };

/** A statement assembled by code from one object of one tool result; never written by the model. */
export type VerifiedFact = {
  subject: string;
  values: FactValue[];
  source: { tool: string; row: number };
  link?: { label: string; href: string };
};

/** Free text from the model: always shown separately and never as a verified fact. */
export type Commentary = { kind: "assumption" | "explanation"; text: string };

export type AgentAnswer = {
  facts: VerifiedFact[];
  commentary: Commentary[];
  /** Model selections the server refused (missing row, unknown field, empty value). */
  rejected: string[];
  limitations: string[];
  toolsUsed: string[];
};

export type AgentStage = { type: "stage"; label: string };
