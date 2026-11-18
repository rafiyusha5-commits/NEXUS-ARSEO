import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { signoutDecision } from "@/lib/auth/signout";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile: { is_active: boolean } | null = null;
  if (user) {
    const { data } = await supabase.from("profiles").select("is_active").eq("id", user.id).maybeSingle();
    profile = data;
  }

  const decision = signoutDecision(Boolean(user), profile);
  if (decision.signOut) await supabase.auth.signOut();
  return NextResponse.redirect(new URL(decision.location, new URL(request.url).origin));
}
