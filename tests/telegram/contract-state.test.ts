import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AGENT_TOOLS } from "../../src/lib/agent/tools.ts";
import { STALE_AFTER_MS, telegramUpdateState, type TelegramUpdateRow } from "../../src/lib/telegram/update-state.ts";

const migration = readFileSync(new URL("../../supabase/migrations/202609275400_telegram_reliability.sql", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../../supabase/migrations/202610240400_assistant_return_cancellation.sql", import.meta.url), "utf8");
const original = readFileSync(new URL("../../supabase/migrations/202609275200_agent_web_mvp.sql", import.meta.url), "utf8");
const runner = readFileSync(new URL("../../src/lib/agent/runner.ts", import.meta.url), "utf8");

function section(sql: string, start: string): string {
  const from = sql.indexOf(start);
  assert.ok(from >= 0, start);
  return sql.slice(from, sql.indexOf("end$$;", from));
}

describe("accounting contract between the runner and agent_finish_run", () => {
  // Regression: voice (speech_to_text, AGENT_SPEECH_ERROR) and date search (date, date_kind) were
  // refused by the database, so those runs never closed and the TTL charged the whole reservation.
  for (const [file, sql] of [["5400", migration], ["5200", original]] as const) {
    it(`accepts every trace entry, parameter and error code the runner produces (${file})`, () => {
      const tools = section(catalog, "create or replace function private.agent_clean_tools");
      for (const tool of AGENT_TOOLS) {
        assert.ok(tools.includes(`'${tool.name}'`), `tool ${tool.name}`);
        for (const key of Object.keys(tool.params)) assert.ok(new RegExp(`'${key}'`).test(tools), `param ${tool.name}.${key}`);
      }
      assert.ok(tools.includes("'speech_to_text'") && tools.includes("'duration_seconds'"), "voice trace");
      const finish = section(sql, "create or replace function public.agent_finish_run(");
      const codes = new Set([...runner.matchAll(/fail\("([A-Z_]+)"\)|finish\("failed", "([A-Z_]+)"/g)].map((match) => match[1] ?? match[2]));
      for (const code of ["QUESTION_EMPTY", "QUESTION_TOO_LONG", "QUESTION_UNSAFE"]) codes.add(code);
      assert.ok(codes.size >= 8);
      for (const code of codes) assert.ok(finish.includes(`'${code}'`), `error code ${code}`);
    });
  }
});

describe("Telegram update state in Nexus", () => {
  const now = Date.parse("2026-10-09T10:00:00Z");
  const row = (patch: Partial<TelegramUpdateRow>): TelegramUpdateRow => ({
    update_id: 1, status: "processing", stage: "model", error_code: null, run_id: "r", created_at: "2026-10-09T09:59:00Z",
    updated_at: new Date(now - 60_000).toISOString(), finished_at: null, ...patch,
  });
  const stale = new Date(now - STALE_AFTER_MS - 1).toISOString();
  it("shows interrupted processing with its stage and that the reservation is held, without retrying", () => {
    const state = telegramUpdateState(row({ updated_at: stale, stage: "speech" }), { id: "r", status: "running", cost_status: "reserved", request_refunded: false, actual_usd_micros: 0 }, now);
    assert.equal(state.label, "Обработка прервана");
    assert.match(state.detail, /распознавание голоса/);
    assert.match(state.detail, /автоматически не повторяются/);
    assert.match(state.detail, /Резерв бюджета удерживается до сверки/);
    assert.equal(telegramUpdateState(row({}), undefined, now).label, "Обрабатывается");
  });
  it("names unknown delivery, refusals, withheld answers and estimated cost", () => {
    assert.equal(telegramUpdateState(row({ status: "delivery_unknown", error_code: "TELEGRAM_UNAVAILABLE" }), undefined, now).label, "Неизвестно, доставлен ли ответ");
    assert.equal(telegramUpdateState(row({ status: "delivery_started", updated_at: stale }), undefined, now).label, "Отправка прервана");
    assert.match(telegramUpdateState(row({ status: "failed", error_code: "TELEGRAM_REJECTED" }), undefined, now).detail, /Telegram отказал/);
    assert.match(telegramUpdateState(row({ status: "completed", error_code: "ANSWER_WITHHELD" }), undefined, now).detail, /доступ отозван/);
    assert.match(telegramUpdateState(row({ status: "completed" }), { id: "r", status: "failed", cost_status: "estimated", request_refunded: false, actual_usd_micros: 272000 }, now).detail, /полному резерву/);
    assert.equal(telegramUpdateState(row({ status: "completed" }), { id: "r", status: "completed", cost_status: "actual", request_refunded: false, actual_usd_micros: 1234 }, now).detail, "Расход учтён: $0.0012.");
  });
});
