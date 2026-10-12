import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reserveCostMicros } from "../../src/lib/agent/config.ts";
import { QuestionPreparationError } from "../../src/lib/agent/runner.ts";
import { SPEECH_RESERVE_MICROS } from "../../src/lib/telegram/speech.ts";
import { ProviderError } from "../../src/lib/agent/types.ts";
import { TelegramError } from "../../src/lib/telegram/client.ts";
import { MIN_RUN_MS, SEND_RESERVE_MS, TELEGRAM_TEXT, processTelegramMessage } from "../../src/lib/telegram/pipeline.ts";
import { ALL_PERMISSIONS, ScriptedProvider, TEST_LIMITS, TEST_PRICING, USER_ID, fakeData, finalAnswer, toolCall } from "../agent/fakes.ts";
import { ANSWER, HangingProvider, OTHER_USER, answered, harness, update, voiceUpdate } from "./pipeline-fakes.ts";

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

