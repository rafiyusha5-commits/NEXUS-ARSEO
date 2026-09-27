import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Asks the database which of the given permission codes the signed-in user has.
// Only hides or shows controls: every rule is enforced again by RLS and triggers.
export async function loadPermissions<const T extends string>(
  supabase: SupabaseClient,
  codes: readonly T[],
): Promise<Record<T, boolean>> {
  const { data, error } = await supabase.rpc("my_permissions", { p_codes: codes });
  const granted = new Set(!error && Array.isArray(data) ? (data as string[]) : []);
  return Object.fromEntries(codes.map((code) => [code, granted.has(code)])) as Record<T, boolean>;
}
