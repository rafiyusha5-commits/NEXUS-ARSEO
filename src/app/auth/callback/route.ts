import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/supabase/config";
import { emailLinkNext, emailLinkToken, safeNextPath } from "@/lib/auth/redirect";

// Opens the session of a sign-in link: the PKCE code of links requested in this browser (password recovery, sign-in),
// or the one-time token hash of e-mail templates (invitations sent by an administrator, recovery). Anything else, or a
// used or expired link, goes back to the login page.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const token = emailLinkToken(url.searchParams.get("token_hash"), url.searchParams.get("type"));
  const nextPath = safeNextPath(url.searchParams.get("next"), url.origin);

  if (hasSupabaseEnv() && (code || token)) {
    const supabase = await createClient();
    if (token) {
      const { error } = await supabase.auth.verifyOtp({ type: token.type, token_hash: token.tokenHash });
      if (!error) return NextResponse.redirect(new URL(emailLinkNext(token.type, nextPath), url.origin));
      return NextResponse.redirect(new URL("/login?error=link", url.origin));
    }
    const { error } = await supabase.auth.exchangeCodeForSession(code!);
    if (!error) return NextResponse.redirect(new URL(nextPath, url.origin));
    return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }

  return NextResponse.redirect(new URL("/login?error=credentials", url.origin));
}
