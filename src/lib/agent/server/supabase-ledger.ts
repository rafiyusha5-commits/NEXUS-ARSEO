import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentLedger, FinishInput, Reservation } from "../types.ts";

const KNOWN = ["AGENT_FORBIDDEN", "AGENT_DAILY_LIMIT", "AGENT_MONTHLY_BUDGET", "AGENT_RUN_BUDGET_EXCEEDED"];

/**
 * Accounting with the server key (service_role). Employees cannot call these RPCs with their own
 * session, so a finish token never reaches them and they cannot report invented usage or refunds.
 * `serverClient` must be used for these two RPCs only: business data is read with the session client.
 * The user id comes from the session the route verified with auth.getUser(); the database checks
 * that this employee is active and holds agent.use, and enforces limits under row locks.
 */
export function createSupabaseLedger(serverClient: SupabaseClient): AgentLedger {
  return {
    async reserve({ userId, channel, questionExcerpt, reserveUsdMicros }) {
      const { data, error } = await serverClient.rpc("agent_reserve_run", {
        p_user_id: userId, p_channel: channel, p_question_excerpt: questionExcerpt, p_reserve_usd_micros: reserveUsdMicros,
      });
      if (error) throw new Error(KNOWN.find((code) => error.message?.includes(code)) ?? "AGENT_LEDGER_ERROR");
      const row = (Array.isArray(data) ? data[0] : data) as { run_id?: string; finish_token?: string; requests_used?: number; request_limit?: number } | null;
      if (!row?.run_id || !row.finish_token) throw new Error("AGENT_LEDGER_ERROR");
      return { userId, runId: row.run_id, finishToken: row.finish_token, requestsUsed: Number(row.requests_used ?? 0), requestLimit: Number(row.request_limit ?? 0) };
    },
    async finish(reservation: Reservation, input: FinishInput) {
      const { error } = await serverClient.rpc("agent_finish_run", {
        p_user_id: reservation.userId, p_run_id: reservation.runId, p_finish_token: reservation.finishToken, p_status: input.status, p_error_code: input.errorCode,
        p_refund: input.refund, p_provider: input.provider, p_model: input.model, p_steps: input.steps, p_tool_calls: input.toolCalls,
        p_input_tokens: input.inputTokens, p_output_tokens: input.outputTokens, p_actual_usd_micros: input.actualUsdMicros,
        p_tools: input.tools,
      });
      if (error) throw new Error("AGENT_LEDGER_ERROR");
    },
  };
}
