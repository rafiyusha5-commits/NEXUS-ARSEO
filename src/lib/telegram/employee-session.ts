import type { SupabaseClient } from "@supabase/supabase-js";

// No passwords or refresh tokens are persisted. The admin client is used only by Auth here.
// The returned client is authenticated as the linked employee, never as service_role.
export async function employeeSession(admin: SupabaseClient, user: SupabaseClient, userId: string): Promise<{ client: SupabaseClient; close: () => Promise<void> }> {
  const identity = await admin.auth.admin.getUserById(userId);
  const account = identity.data.user;
  if (identity.error || !account?.email || account.id !== userId || account.factors?.some(factor => factor.status === "verified")) throw new Error("TELEGRAM_SESSION_UNAVAILABLE");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.email });
  if (link.error || link.data.user?.id !== userId || !link.data.properties?.hashed_token) throw new Error("TELEGRAM_SESSION_UNAVAILABLE");
  const verified = await user.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const close = async () => { await user.auth.signOut({ scope: "local" }); };
  if (verified.error || verified.data.user?.id !== userId || !verified.data.session) {
    await close(); throw new Error("TELEGRAM_SESSION_UNAVAILABLE");
  }
  const permissions = await user.rpc("my_permissions", { p_codes: ["agent.use"] });
  if (permissions.error || !Array.isArray(permissions.data) || !permissions.data.includes("agent.use")) {
    await close(); throw new Error("AGENT_FORBIDDEN");
  }
  return { client: user, close };
}
