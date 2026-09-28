"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/supabase/config";

function loginError(code: string): never {
  redirect(`/login?error=${encodeURIComponent(code)}`);
}

export async function login(formData: FormData) {
  if (!hasSupabaseEnv()) loginError("configuration");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !email.includes("@") || password.length < 8) {
    loginError("validation");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.status === 0 || error.name === "AuthRetryableFetchError") {
      loginError("connection");
    }

    if (error.status === 429) loginError("rate_limit");
    loginError("credentials");
  }
  redirect("/");
}

export async function logout() {
  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
