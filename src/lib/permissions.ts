import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// Answers already requested during this server render, per Supabase client and permission code. A page asks once
// for the codes of the panels it renders (requirePageUser), and a panel that gets the same client (requireUser is
// memoized per render) reads them from here instead of making its own round trip. Outside a render (server actions,
// route handlers) cache() keeps nothing, so every check there goes to the database as before.
const answered = cache(() => new WeakMap<SupabaseClient, Map<string, Promise<boolean>>>());

// Asks the database which of the given permission codes the signed-in user has.
// Only hides or shows controls: every rule is enforced again by RLS and triggers.
export async function loadPermissions<const T extends string>(
  supabase: SupabaseClient,
  codes: readonly T[],
): Promise<Record<T, boolean>> {
  const byClient = answered();
  const known = byClient.get(supabase) ?? new Map<string, Promise<boolean>>();
  byClient.set(supabase, known);
  const missing = [...new Set(codes.filter((code) => !known.has(code)))];
  if (missing.length) {
    const granted = (async () => {
      const { data, error } = await supabase.rpc("my_permissions", { p_codes: missing });
      return new Set(!error && Array.isArray(data) ? (data as string[]) : []);
    })();
    for (const code of missing) known.set(code, granted.then((set) => set.has(code)));
  }
  const values = await Promise.all(codes.map((code) => known.get(code)!));
  return Object.fromEntries(codes.map((code, index) => [code, values[index]])) as Record<T, boolean>;
}
