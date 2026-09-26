"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/supabase/config";

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!hasSupabaseEnv() || !email || !email.includes("@")) {
    redirect("/forgot-password?error=validation");
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? "http://localhost:3000";
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/update-password`,
  });

  if (error) {
    console.error("[password-reset] Supabase rejected the request", {
      code: error.code,
      status: error.status,
      message: error.message,
    });

    const knownErrorCodes = new Set([
      "email_address_invalid",
      "email_address_not_authorized",
      "over_email_send_rate_limit",
      "over_request_rate_limit",
      "request_timeout",
    ]);
    const errorCode =
      error.code && knownErrorCodes.has(error.code) ? error.code : "send";

    redirect(`/forgot-password?error=${errorCode}`);
  }
  redirect("/forgot-password?sent=1");
}
