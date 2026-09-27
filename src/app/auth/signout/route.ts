import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const requestUrl = new URL(request.url);
  const loginUrl = new URL("/login", requestUrl.origin);
  if (requestUrl.searchParams.get("reason") === "disabled") {
    loginUrl.searchParams.set("error", "disabled");
  }

  return NextResponse.redirect(loginUrl);
}
