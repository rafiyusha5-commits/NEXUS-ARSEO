import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TELEGRAM_TEXT, processTelegramMessage, type PipelineTiming } from "../../src/lib/telegram/pipeline.ts";
import type { AgentLedger } from "../../src/lib/agent/types.ts";
import { ScriptedProvider, finalAnswer, toolCall } from "../agent/fakes.ts";
import { ANSWER, answered, delay, harness, update, type Harness } from "./pipeline-fakes.ts";

// The real plan scaled down 60×, so slow steps can be simulated quickly.
const TIMING: PipelineTiming = {
  deadlineMs: 1_250, sendReserveMs: 330, minRunMs: 300, deliveryMs: 200,
  sendTimeoutMs: 130, minSendMs: 35, finalWriteMs: 35, progressMs: 50, closeMs: 65,
};
const SLACK_MS = 60;

async function run(h: Harness, id: number, timing: PipelineTiming = TIMING): Promise<{ t0: number; elapsed: number }> {
  h.deps.timing = timing;
  // AbortSignal.timeout does not keep the test process alive; a server process is alive anyway.
  const alive = setInterval(() => undefined, 20);
  const t0 = Date.now();
  try {
    await processTelegramMessage(update(id), h.deps);
  } finally {
    clearInterval(alive);
  }
  return { t0, elapsed: Date.now() - t0 };
}

/** Nothing starts after the deadline, and sendMessage cannot outlive it. */
function assertInsideDeadline(h: Harness, t0: number, elapsed: number, timing: PipelineTiming = TIMING) {
  const end = t0 + timing.deadlineMs;
  assert.ok(elapsed <= timing.deadlineMs + SLACK_MS, `processing took ${elapsed} ms`);
  for (const call of h.db.started) assert.ok(call.at <= end + SLACK_MS, `${call.step} started ${call.at - end} ms after the deadline`);
  for (const send of h.bot.sends) {
    assert.ok(send.at + send.timeoutMs <= end + SLACK_MS, `sendMessage may run until ${send.at + send.timeoutMs - end} ms after the deadline`);
  }
}

describe("Telegram pipeline: one deadline over the whole chain", () => {
  it("still answers in time when progress writes, the final status and the session close hang", async () => {
    const h = harness(answered());
    h.db.delays = { "progress:session": Infinity, "progress:model": Infinity, "progress:access_check": Infinity, "status:completed": Infinity };
    h.closeDelayMs = Infinity;
    const { t0, elapsed } = await run(h, 1);
    assertInsideDeadline(h, t0, elapsed);
    assert.equal(h.bot.sent.length, 1);
    assert.match(h.bot.sent[0], /NAR-2026-0007/);
    assert.equal(h.closed, 1, "the signOut was started");
    assert.equal(h.ledger.finished.length, 1);
  });

  it("fails closed when the access re-check is too slow: no business data is sent", async () => {
    const h = harness(answered());
    // The first lookup resolves the employee; the re-check before delivery hangs.
    h.db.delays = { telegram_employee: (count) => (count === 1 ? 0 : Infinity) };
    const { t0, elapsed } = await run(h, 2);
    assertInsideDeadline(h, t0, elapsed);
    assert.deepEqual(h.bot.sent, [TELEGRAM_TEXT.failed]);
    assert.equal(h.db.updates.get(2)!.status, "completed");
  });

  it("does not send when the delivery mark cannot be written in time", async () => {
    const h = harness(answered());
    h.db.delays = { "status:delivery_started": Infinity };
    const { t0, elapsed } = await run(h, 3);
    assertInsideDeadline(h, t0, elapsed);
    assert.equal(h.bot.sends.length, 0, "never sent without the point of no return");
    assert.ok(h.db.started.some((call) => call.step === "status:failed"), "recorded as not delivered");
  });

  it("bounds a hanging sendMessage and records the unknown outcome before the deadline", async () => {
    const h = harness(answered());
    h.bot.sendDelayMs = 10_000;
    const { t0, elapsed } = await run(h, 4);
    assertInsideDeadline(h, t0, elapsed);
    assert.equal(h.bot.sends.length, 1, "no second attempt");
    assert.equal(h.db.updates.get(4)!.status, "delivery_unknown");
  });

  it("bounds a slow closing ledger write of the run and answers without data in time", async () => {
    const h = harness(answered());
    const ledger = h.ledger;
    const slow: AgentLedger = { reserve: (input) => ledger.reserve(input), finish: async (reservation, input) => { await delay(5_000); return ledger.finish(reservation, input); } };
    h.deps.agent = ((original) => () => ({ ...original()!, ledger: slow }))(h.deps.agent);
    const { t0, elapsed } = await run(h, 5);
    assertInsideDeadline(h, t0, elapsed);
    assert.deepEqual(h.bot.sent, [TELEGRAM_TEXT.failed]);
  });

  it("never starts sending after the deadline: when the time is gone the message is not sent", async () => {
    const h = harness(new ScriptedProvider([toolCall("c1", "find_shipments", { query: "NAR-2026-0007", status: null, type: null, limit: null }), finalAnswer(ANSWER)]));
    // A clock jump during the access re-check (for example a paused process) uses up the deadline.
    let offset = 0;
    h.deps.now = () => Date.now() + offset;
    h.db.delays = { telegram_employee: (count) => { if (count === 2) offset = TIMING.deadlineMs; return 0; } };
    const { t0, elapsed } = await run(h, 6);
    assertInsideDeadline(h, t0, elapsed);
    assert.equal(h.bot.sends.length, 0);
    assert.ok(!h.db.started.some((call) => call.step === "status:delivery_started"), "no delivery mark without time to send");
  });

  it("keeps the whole default plan inside the route and worker limits", async () => {
    const { DEFAULT_TIMING } = await import("../../src/lib/telegram/pipeline.ts");
    const t = DEFAULT_TIMING;
    assert.ok(t.deadlineMs < 90_000, "below maxDuration of the route");
    assert.ok(t.sendReserveMs >= t.deliveryMs + t.closeMs, "after the run: access check, close and delivery fit");
    assert.ok(t.deliveryMs >= t.minSendMs + t.finalWriteMs + t.progressMs, "delivery: mark, send and final status fit");
    assert.ok(t.sendTimeoutMs + t.finalWriteMs <= t.deliveryMs);
  });
});
