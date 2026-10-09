// Shared fakes of the Telegram pipeline: an in-memory twin of the telegram_* RPCs, a Bot API double
// and a harness. Optional delays let tests slow down any single step.
import { ProviderError, type AgentModelProvider, type ModelRequest, type ModelResponse } from "../../src/lib/agent/types.ts";
import { TelegramError, type TelegramBot } from "../../src/lib/telegram/client.ts";
import type { EmployeeSession, TelegramPipelineDeps } from "../../src/lib/telegram/pipeline.ts";
import { ALL_PERMISSIONS, FakeLedger, ScriptedProvider, TEST_LIMITS, TEST_PRICING, USER_ID, fakeData, finalAnswer, toolCall } from "../agent/fakes.ts";

/** Resolves after `ms`; `Infinity` never resolves (a hung request). */
export function delay(ms: number): Promise<void> {
  return ms === Infinity ? new Promise(() => undefined) : new Promise((resolve) => setTimeout(resolve, ms));
}

export const CHAT = 4242;
export const OTHER_USER = "44444444-4444-4444-8444-444444444444";
export const update = (id: number, extra: Record<string, unknown> = { text: "Где поставка NAR-2026-0007?" }) => ({
  update_id: id, message: { message_id: id, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "Сотрудник" }, ...extra },
});
export const voiceUpdate = (id: number) => update(id, { voice: { file_id: "voice_1", duration: 9, file_size: 4000 } });
export const ANSWER = { facts: [{ call: "c1", row: 0, fields: ["shipment_status"] }], commentary: [], limitations: [] };

type Row = { status: string; stage: string; error: string | null; userId: string | null; runId: string | null; token: string };

/** In-memory twin of telegram_* RPCs with the same transition rules as migration 5400. */
export class FakeDatabase {
  readonly updates = new Map<number, Row>();
  readonly calls: string[] = [];
  linked: string | null = USER_ID;
  failClaim = false;
  failDeliveryMark = false;
  private next = 0;
  /** Delay per step: an RPC name, or "progress:<stage>" / "status:<status>"; a function sees the call count. */
  delays: Record<string, number | ((count: number) => number)> = {};
  readonly started: Array<{ step: string; at: number }> = [];
  private counts = new Map<string, number>();
  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const step = name === "telegram_update_progress" ? `progress:${String(args.p_stage)}` : name === "telegram_update_status" ? `status:${String(args.p_status)}` : name;
    const count = (this.counts.get(step) ?? 0) + 1;
    this.counts.set(step, count);
    this.started.push({ step, at: Date.now() });
    const wait = this.delays[step];
    const ms = typeof wait === "function" ? wait(count) : wait ?? 0;
    if (ms) await delay(ms);
    this.calls.push(name);
    const row = this.updates.get(Number(args.p_update_id));
    const owns = row && row.token === args.p_token;
    switch (name) {
      case "telegram_claim_update": {
        if (this.failClaim) throw new Error("TELEGRAM_DATABASE_UNAVAILABLE");
        await Promise.resolve();
        if (this.updates.has(Number(args.p_update_id))) return null;
        const token = `claim-${++this.next}`;
        this.updates.set(Number(args.p_update_id), { status: "processing", stage: "received", error: null, userId: null, runId: null, token });
        return token;
      }
      case "telegram_employee": return this.linked;
      case "telegram_update_progress":
        if (!owns || !["processing", "delivery_started"].includes(row.status)) return false;
        row.stage = String(args.p_stage);
        row.userId = (args.p_user_id as string | null) ?? row.userId;
        row.runId = (args.p_run_id as string | null) ?? row.runId;
        row.error = (args.p_error_code as string | null) ?? row.error;
        return true;
      case "telegram_update_status": {
        const to = String(args.p_status);
        if (to === "delivery_started" && this.failDeliveryMark) throw new Error("TELEGRAM_DATABASE_UNAVAILABLE");
        const allowed = owns && ((row.status === "processing" && ["delivery_started", "failed"].includes(to))
          || (row.status === "delivery_started" && ["completed", "failed", "delivery_unknown"].includes(to)));
        if (!allowed) return false;
        row.status = to;
        row.stage = to === "delivery_started" ? "sending" : "done";
        return true;
      }
      default: throw new Error(`unexpected rpc ${name}`);
    }
  }
}

export class FakeBot implements TelegramBot {
  readonly sent: string[] = [];
  readonly methods: string[] = [];
  readonly documents: Blob[] = [];
  sendError: Error | null = null;
  downloadError = false;
  /** sendMessage that takes this long; it honours the caller's timeout and deadline like the real client. */
  sendDelayMs = 0;
  readonly sends: Array<{ at: number; timeoutMs: number }> = [];
  async call(method: string, payload: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    this.methods.push(method);
    if (method === "sendMessage" || method === "sendDocument") {
      this.sends.push({ at: Date.now(), timeoutMs: options.timeoutMs ?? Infinity });
      if (this.sendDelayMs) {
        const abort = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 12_000)]);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.sendDelayMs);
          abort.addEventListener("abort", () => { clearTimeout(timer); reject(new TelegramError("TELEGRAM_UNAVAILABLE")); }, { once: true });
        });
      }
      if (method === "sendDocument") this.documents.push(payload.document as Blob);
      this.sent.push(String(payload.text ?? payload.caption));
      if (this.sendError) throw this.sendError;
      return { message_id: 1 };
    }
    if (method === "getFile") return { file_path: "voice/file_1.oga", file_size: 4000 };
    return true;
  }
  async downloadVoice(): Promise<Response> {
    if (this.downloadError) throw new TelegramError("TELEGRAM_UNAVAILABLE");
    return new Response(new Uint8Array([1, 2, 3]));
  }
}

export type Harness = { db: FakeDatabase; bot: FakeBot; ledger: FakeLedger; opened: number; closed: number; closeDelayMs: number; granted: Set<string>; deps: TelegramPipelineDeps };

type Transcribe = (audio: Uint8Array, signal: AbortSignal) => Promise<{ text: string; costUsdMicros: number; durationSeconds: number }>;
export function harness(provider: AgentModelProvider, options: Partial<TelegramPipelineDeps> & { transcribe?: Transcribe; runDeadlineMs?: number } = {}): Harness {
  const h = { db: new FakeDatabase(), bot: new FakeBot(), ledger: new FakeLedger(), opened: 0, closed: 0, closeDelayMs: 0, granted: new Set(ALL_PERMISSIONS) } as Harness;
  const session = (): EmployeeSession => ({
    permissions: async (codes) => new Set(codes.filter((code) => h.granted.has(code))),
    data: fakeData(),
    usage: async () => ({ used: 3, limit: 20 }),
    close: async () => { h.closed += 1; await delay(h.closeDelayMs); },
  });
  h.deps = {
    rpc: (name, args) => h.db.rpc(name, args),
    bot: h.bot,
    voiceEnabled: true,
    openSession: async () => { h.opened += 1; return session(); },
    agent: () => ({
      provider, ledger: h.ledger, pricing: TEST_PRICING,
      limits: { ...TEST_LIMITS, runDeadlineMs: options.runDeadlineMs ?? TEST_LIMITS.runDeadlineMs },
      transcribe: options.transcribe ?? (async () => ({ text: "Где поставка NAR-2026-0007?", costUsdMicros: 225, durationSeconds: 9.0208 })),
    }),
    ...options,
  };
  return h;
}

export const answered = () => new ScriptedProvider([toolCall("c1", "find_shipments", { query: "NAR-2026-0007", status: null, type: null, limit: null }), finalAnswer(ANSWER)]);

/** A provider that never answers until the request is aborted (a hung model call). */
export class HangingProvider implements AgentModelProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls = 0;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new ProviderError("AGENT_TIMEOUT", undefined, false)), { once: true }));
  }
}

