import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAgentConfig } from "../config.ts";
import { OpenAiProvider } from "../providers/openai.ts";
import { runAgent, type RunOutcome } from "../runner.ts";
import { createSupabaseAgentData } from "./supabase-data.ts";
import { createSupabaseLedger } from "./supabase-ledger.ts";

/** Fresh permission set from the database for the session user (my_permissions). */
export function sessionPermissions(supabase: SupabaseClient) {
  return async (codes: readonly string[]): Promise<ReadonlySet<string>> => {
    const { data, error } = await supabase.rpc("my_permissions", { p_codes: [...codes] });
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.filter((code): code is string => typeof code === "string"));
  };
}

/**
 * Runs the assistant for the signed-in employee. `supabase` must be the request's session client
 * (cookies) and `userId` the user it verified; business data, permissions and tools use only that
 * session. The server key is used for the two accounting RPCs and nothing else.
 */
export async function runWebAssistant(supabase: SupabaseClient, userId: string, question: unknown, onStage: (label: string) => void, conversationId?: string): Promise<RunOutcome> {
  const config = loadAgentConfig();
  if (!config.enabled) return { ok: false, code: "AGENT_DISABLED", message: "Ассистент выключен.", refunded: false };
  const serverClient = createAdminClient();
  if (!serverClient) return { ok: false, code: "AGENT_DISABLED", message: "Ассистент выключен.", refunded: false };
  return runAgent(question, {
    operationsEnabled: process.env.AGENT_OPERATIONS_ENABLED === "true",
    channel: "web",
    conversationKey: conversationId,
    userId,
    provider: new OpenAiProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort }),
    ledger: createSupabaseLedger(serverClient),
    data: createSupabaseAgentData(supabase),
    permissions: sessionPermissions(supabase),
    limits: config.limits,
    pricing: config.pricing,
    onStage,
  });
}
