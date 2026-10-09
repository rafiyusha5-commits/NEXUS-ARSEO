import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "../supabase/config";
import { loadAgentConfig } from "../agent/config.ts";
import { OpenAiProvider } from "../agent/providers/openai.ts";
import { createSupabaseAgentData } from "../agent/server/supabase-data.ts";
import { createSupabaseLedger } from "../agent/server/supabase-ledger.ts";
import { sessionPermissions } from "../agent/server/service.ts";
import { transcribeVoice } from "./speech.ts";
import type { TelegramClient } from "./client.ts";
import { employeeSession } from "./employee-session.ts";
import { processTelegramMessage } from "./pipeline.ts";

/** Every Supabase request of the Telegram path is bounded; a hung request cannot hold the message. */
export const SUPABASE_REQUEST_TIMEOUT_MS = 8_000;

export function timedFetch(ms: number, deadline?: AbortSignal): typeof fetch {
  return (input, init) => {
    const signals = [AbortSignal.timeout(ms), ...(deadline ? [deadline] : []), ...(init?.signal ? [init.signal] : [])];
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

function serverClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const { url } = getSupabaseEnv();
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(SUPABASE_REQUEST_TIMEOUT_MS) } });
}

/** Thrown before the update is claimed: the worker may deliver it again, nothing ran. */
export class TelegramUnavailable extends Error {
  constructor() { super("TELEGRAM_DATABASE_UNAVAILABLE"); }
}

export async function processTelegramUpdate(update: unknown, bot: TelegramClient): Promise<void> {
  const admin = serverClient();
  if (!admin) throw new TelegramUnavailable();
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await admin.rpc(name, args);
    if (response.error) throw new TelegramUnavailable();
    return response.data;
  };
  await processTelegramMessage(update, {
    rpc,
    bot,
    voiceEnabled: process.env.TELEGRAM_VOICE_ENABLED === "true" && process.env.TELEGRAM_VOICE_ACKNOWLEDGED === "true",
    async openSession(userId, deadline) {
      if (deadline.aborted) throw new TelegramUnavailable();
      const { url, publishableKey } = getSupabaseEnv();
      // The employee client carries only the employee's own session; RLS applies to every read.
      // Per-request timeout only, not the message deadline: the closing signOut must still go out
      // after the deadline, otherwise the temporary session would stay valid.
      const user = createClient(url, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: timedFetch(SUPABASE_REQUEST_TIMEOUT_MS) },
      });
      const session = await employeeSession(admin, user, userId);
      return {
        permissions: sessionPermissions(session.client),
        data: createSupabaseAgentData(session.client),
        async usage() {
          const usage = await session.client.rpc("my_agent_usage");
          const row = Array.isArray(usage.data) ? usage.data[0] : usage.data;
          if (usage.error || !row) throw new TelegramUnavailable();
          return { used: Number(row.requests_used), limit: Number(row.request_limit) };
        },
        close: session.close,
      };
    },
    agent() {
      const config = loadAgentConfig();
      if (!config.enabled) return null;
      return {
        provider: new OpenAiProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort }),
        // Accounting only, with the server key; business data stays on the employee session.
        ledger: createSupabaseLedger(admin),
        limits: config.limits,
        pricing: config.pricing,
        transcribe: (audio, signal) => transcribeVoice(audio, config.apiKey, signal),
      };
    },
  });
}
