import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reserveCostMicros } from "../../src/lib/agent/config.ts";
import { QuestionPreparationError } from "../../src/lib/agent/runner.ts";
import { SPEECH_RESERVE_MICROS } from "../../src/lib/telegram/speech.ts";
import { ProviderError, type AgentModelProvider, type ModelRequest, type ModelResponse } from "../../src/lib/agent/types.ts";
import { TelegramError, type TelegramBot } from "../../src/lib/telegram/client.ts";
import { MIN_RUN_MS, SEND_RESERVE_MS, TELEGRAM_TEXT, processTelegramMessage, type EmployeeSession, type TelegramPipelineDeps } from "../../src/lib/telegram/pipeline.ts";
import { ALL_PERMISSIONS, FakeLedger, ScriptedProvider, TEST_LIMITS, TEST_PRICING, USER_ID, fakeData, finalAnswer, toolCall } from "../agent/fakes.ts";

const CHAT = 4242;
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const update = (id: number, extra: Record<string, unknown> = { text: "Где поставка NAR-2026-0007?" }) => ({
  update_id: id, message: { message_id: id, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "Сотрудник" }, ...extra },
});
const voiceUpdate = (id: number) => update(id, { voice: { file_id: "voice_1", duration: 9, file_size: 4000 } });
const ANSWER = { facts: [{ call: "c1", row: 0, fields: ["shipment_status"] }], commentary: [], limitations: [] };

type Row = { status: string; stage: string; error: string | null; userId: string | null; runId: string | null; token: string };

/** In-memory twin of telegram_* RPCs with the same transition rules as migration 5400. */
class FakeDatabase {
  readonly updates = new Map<number, Row>();
  readonly calls: string[] = [];
  linked: string | null = USER_ID;
  failClaim = false;
  failDeliveryMark = false;
  private next = 0;
  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
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

class FakeBot implements TelegramBot {
  readonly sent: string[] = [];
  readonly methods: string[] = [];
  sendError: Error | null = null;
  downloadError = false;
  async call(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    this.methods.push(method);
    if (method === "sendMessage") {
      this.sent.push(String(payload.text));
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

type Harness = { db: FakeDatabase; bot: FakeBot; ledger: FakeLedger; opened: number; closed: number; granted: Set<string>; deps: TelegramPipelineDeps };

type Transcribe = (audio: Uint8Array, signal: AbortSignal) => Promise<{ text: string; costUsdMicros: number; durationSeconds: number }>;
function harness(provider: AgentModelProvider, options: Partial<TelegramPipelineDeps> & { transcribe?: Transcribe; runDeadlineMs?: number } = {}): Harness {
  const h = { db: new FakeDatabase(), bot: new FakeBot(), ledger: new FakeLedger(), opened: 0, closed: 0, granted: new Set(ALL_PERMISSIONS) } as Harness;
  const session = (): EmployeeSession => ({
    permissions: async (codes) => new Set(codes.filter((code) => h.granted.has(code))),
    data: fakeData(),
    usage: async () => ({ used: 3, limit: 20 }),
    close: async () => { h.closed += 1; },
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

const answered = () => new ScriptedProvider([toolCall("c1", "find_shipments", { query: "NAR-2026-0007", status: null, type: null, limit: null }), finalAnswer(ANSWER)]);

/** A provider that never answers until the request is aborted (a hung model call). */
class HangingProvider implements AgentModelProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls = 0;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new ProviderError("AGENT_TIMEOUT", undefined, false)), { once: true }));
  }
}

describe("Telegram pipeline: delivery, accounting and access", () => {
  it("answers a text question once: one reservation, one finish, one message, session closed", async () => {
    const h = harness(answered());
    await processTelegramMessage(update(1), h.deps);
    assert.equal(h.ledger.reservations.length, 1);
    assert.equal(h.ledger.finished.length, 1);
    assert.equal(h.ledger.finished[0].status, "completed");
    assert.equal(h.bot.sent.length, 1);
    assert.match(h.bot.sent[0], /Поставка NAR-2026-0007/);
    const row = h.db.updates.get(1)!;
    assert.deepEqual([row.status, row.error, row.userId, row.runId], ["completed", null, USER_ID, "run-1"]);
    assert.deepEqual([h.opened, h.closed], [1, 1]);
  });

  it("never runs a repeated delivery again: restart, redelivery and a second worker in parallel", async () => {
    const provider = answered();
    const h = harness(provider);
    await Promise.all([processTelegramMessage(update(2), h.deps), processTelegramMessage(update(2), h.deps)]);
    await processTelegramMessage(update(2), h.deps);
    assert.equal(provider.requests.length, 2, "one run: a tool call and the final answer");
    assert.equal(h.ledger.reservations.length, 1, "charged once");
    assert.equal(h.bot.sent.length, 1, "answered once");
    assert.equal(h.opened, 1);
  });

  it("throws before the claim when the database is unavailable, so the worker may retry without any cost", async () => {
    const h = harness(answered());
    h.db.failClaim = true;
    await assert.rejects(processTelegramMessage(update(3), h.deps));
    assert.equal(h.ledger.reservations.length, 0);
    assert.equal(h.bot.sent.length, 0);
    assert.equal(h.opened, 0);
  });

  it("charges a model call with unknown result conservatively and returns the question", async () => {
    const h = harness(new ScriptedProvider([new ProviderError("AGENT_PROVIDER_ERROR", undefined, false)]));
    await processTelegramMessage(update(4), h.deps);
    const finish = h.ledger.finished[0];
    assert.equal(finish.status, "failed");
    assert.equal(finish.refund, true, "the employee's question is returned");
    assert.ok(finish.actualUsdMicros > 0, "unknown spend is not released silently");
    assert.equal(h.db.updates.get(4)!.error, "AGENT_PROVIDER_ERROR");
    assert.equal(h.bot.sent.length, 1);

    const rejected = harness(new ScriptedProvider([new ProviderError("AGENT_PROVIDER_ERROR", undefined, true)]));
    await processTelegramMessage(update(5), rejected.deps);
    assert.equal(rejected.ledger.finished[0].actualUsdMicros, 0, "a request the provider refused costs nothing");
  });

  it("ends a hung model call by the run deadline, charges it as unknown and still answers in time", async () => {
    const provider = new HangingProvider();
    const h = harness(provider, { runDeadlineMs: 300 });
    const started = Date.now();
    // AbortSignal.timeout does not keep the test process alive; a server process is alive anyway.
    const alive = setInterval(() => undefined, 50);
    await processTelegramMessage(update(6), h.deps).finally(() => clearInterval(alive));
    assert.ok(Date.now() - started < 5_000);
    assert.equal(provider.calls, 1);
    assert.equal(h.ledger.finished[0].errorCode, "AGENT_TIMEOUT");
    assert.ok(h.ledger.finished[0].actualUsdMicros > 0);
    assert.equal(h.bot.sent.length, 1);
    assert.equal(h.closed, 1);
  });

  it("does not start a question without enough time left: nothing reserved or charged", async () => {
    const h = harness(answered(), { deadlineMs: SEND_RESERVE_MS + MIN_RUN_MS - 1 });
    await processTelegramMessage(update(7), h.deps);
    assert.equal(h.ledger.reservations.length, 0);
    assert.equal(h.bot.sent[0], TELEGRAM_TEXT.noTime);
    assert.equal(h.db.updates.get(7)!.error, "DEADLINE_EXCEEDED");
    assert.equal(h.closed, 1);
  });

  it("closes a temporary session that opens only after its step timed out", async () => {
    const h = harness(answered(), { deadlineMs: SEND_RESERVE_MS + 100 });
    let release!: () => void;
    let closedLate = false;
    h.deps.openSession = () => new Promise((resolve) => {
      release = () => resolve({ permissions: async () => new Set(ALL_PERMISSIONS), data: fakeData(), usage: async () => ({ used: 0, limit: 20 }), close: async () => { closedLate = true; } });
    });
    await processTelegramMessage(update(8), h.deps);
    assert.equal(h.bot.sent[0], TELEGRAM_TEXT.failed);
    assert.equal(h.ledger.reservations.length, 0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closedLate, true, "the late session is signed out, not leaked");
  });

  it("withholds business data when access is revoked, the employee deactivated or the chat relinked during processing", async () => {
    for (const change of ["revoke", "relink"] as const) {
      const provider = new ScriptedProvider([
        (request) => request.tools.length ? toolCall("c1", "find_shipments", { query: "NAR-2026-0007", status: null, type: null, limit: null }) : finalAnswer(ANSWER),
        finalAnswer(ANSWER),
      ]);
      const h = harness(provider);
      const original = h.deps.rpc;
      let runs = 0;
      h.deps.rpc = async (name, args) => {
        // The change happens after the model finished, right before delivery.
        if (name === "telegram_update_progress" && args.p_stage === "access_check" && runs++ === 0) {
          if (change === "revoke") h.granted.delete("agent.use"); else h.db.linked = OTHER_USER;
        }
        return original(name, args);
      };
      await processTelegramMessage(update(9), h.deps);
      assert.equal(h.bot.sent.length, 1);
      assert.equal(h.bot.sent[0], TELEGRAM_TEXT.withheld, change);
      assert.doesNotMatch(h.bot.sent[0], /NAR-2026|В пути/);
      assert.equal(h.db.updates.get(9)!.error, "ANSWER_WITHHELD");
      assert.equal(h.closed, 1);
    }
  });

  it("refuses access revoked before the run without reserving the budget", async () => {
    const h = harness(answered());
    h.granted.delete("agent.use");
    await processTelegramMessage(update(10), h.deps);
    assert.equal(h.ledger.reservations.length, 0);
    assert.doesNotMatch(h.bot.sent[0], /NAR-2026/);
  });

  it("never resends when Telegram's answer is unknown and marks the state instead", async () => {
    const h = harness(answered());
    h.bot.sendError = new TelegramError("TELEGRAM_UNAVAILABLE");
    await processTelegramMessage(update(11), h.deps);
    assert.equal(h.bot.methods.filter((method) => method === "sendMessage").length, 1, "no second attempt and no extra error message");
    assert.deepEqual([h.db.updates.get(11)!.status, h.db.updates.get(11)!.error], ["delivery_unknown", "TELEGRAM_UNAVAILABLE"]);
    assert.equal(h.ledger.reservations.length, 1);

    const refused = harness(answered());
    refused.bot.sendError = new TelegramError("TELEGRAM_REJECTED");
    await processTelegramMessage(update(12), refused.deps);
    assert.deepEqual([refused.db.updates.get(12)!.status, refused.db.updates.get(12)!.error], ["failed", "TELEGRAM_REJECTED"]);
  });

  it("does not send at all when the point of no return cannot be recorded", async () => {
    const h = harness(answered());
    h.db.failDeliveryMark = true;
    await processTelegramMessage(update(13), h.deps);
    assert.equal(h.bot.sent.length, 0);
    assert.equal(h.db.updates.get(13)!.status, "failed");
  });
});

describe("Telegram pipeline: voice and answer are one question", () => {
  it("reserves once for speech and model and records both costs in one finish", async () => {
    const h = harness(answered());
    await processTelegramMessage(voiceUpdate(20), h.deps);
    assert.equal(h.ledger.reservations.length, 1);
    assert.equal(h.ledger.reservations[0].reserveUsdMicros, reserveCostMicros(TEST_LIMITS, TEST_PRICING) + SPEECH_RESERVE_MICROS, "speech and model in one reservation");
    assert.equal(h.ledger.finished.length, 1);
    const finish = h.ledger.finished[0];
    const model = (1000 + 1500) * TEST_PRICING.inputUsdPerMTok + (50 + 200) * TEST_PRICING.outputUsdPerMTok;
    assert.equal(finish.actualUsdMicros, model + 225, "speech and model in one finish");
    assert.deepEqual(finish.tools[0], { name: "speech_to_text", params: { duration_seconds: 9 }, rows: 0, truncated: false, ms: 0 });
    assert.match(h.bot.sent[0], /^Распознано: /);
    assert.equal(h.db.updates.get(20)!.runId, "run-1");
  });

  it("returns the question after a failed download without any speech cost", async () => {
    const h = harness(answered());
    h.bot.downloadError = true;
    await processTelegramMessage(voiceUpdate(21), h.deps);
    assert.deepEqual([h.ledger.finished[0].errorCode, h.ledger.finished[0].refund, h.ledger.finished[0].actualUsdMicros], ["AGENT_SPEECH_ERROR", true, 0]);
  });

  it("keeps the speech reservation charged when transcription failed with an unknown result", async () => {
    const h = harness(answered(), { transcribe: async () => { throw new QuestionPreparationError("VOICE_PROVIDER", 20_000); } });
    await processTelegramMessage(voiceUpdate(22), h.deps);
    assert.deepEqual([h.ledger.finished[0].errorCode, h.ledger.finished[0].refund, h.ledger.finished[0].actualUsdMicros], ["AGENT_SPEECH_ERROR", true, 20_000]);
    assert.equal(h.ledger.finished.length, 1, "closed once");
  });

  it("answers /limit through the employee session without reserving and closes it", async () => {
    const h = harness(answered());
    await processTelegramMessage(update(23, { text: "/limit" }), h.deps);
    assert.match(h.bot.sent[0], /3 из 20/);
    assert.equal(h.ledger.reservations.length, 0);
    assert.deepEqual([h.opened, h.closed], [1, 1]);
  });

  it("keeps unlinked chats away from sessions and the model", async () => {
    const h = harness(answered());
    h.db.linked = null;
    await processTelegramMessage(update(24), h.deps);
    assert.equal(h.bot.sent[0], TELEGRAM_TEXT.notLinked);
    assert.deepEqual([h.opened, h.ledger.reservations.length], [0, 0]);
  });
});
