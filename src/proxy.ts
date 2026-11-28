import type { NextRequest } from "next/server";
import { contentSecurityPolicy, createNonce, NONCE_HEADER } from "@/lib/security/headers";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // A fresh nonce per request (src/lib/security/headers.ts). Next.js reads the policy from the request headers and
  // puts the nonce on its scripts; the browser gets the same policy with the response.
  const nonce = createNonce();
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const response = await updateSession(request, new Headers({ [NONCE_HEADER]: nonce, "Content-Security-Policy": policy }));
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    // The web app manifest is fetched without the session cookie (202611280500): it must not be redirected to the login.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
