import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, hasSupabaseEnv } from "./config";

function copySessionState(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie));
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = source.headers.get(header);
    if (value) target.headers.set(header, value);
  }
  return target;
}

/**
 * `extraHeaders` are added to the request the application sees (the CSP nonce of src/proxy.ts). They are applied on
 * top of the current request headers each time, so cookies refreshed below reach the server components too.
 */
export async function updateSession(request: NextRequest, extraHeaders?: Headers) {
  const next = () => {
    if (!extraHeaders) return NextResponse.next({ request });
    const headers = new Headers(request.headers);
    extraHeaders.forEach((value, name) => headers.set(name, value));
    return NextResponse.next({ request: { headers } });
  };
  // Public responses contain only ok/unavailable. Liveness must not depend on Auth/DB.
  if (["/api/health/live", "/api/health/ready"].includes(request.nextUrl.pathname)) return next();
  // Exact internal worker route authenticates with its own server secret, never employee cookies.
  if (request.nextUrl.pathname === "/api/telegram/process") return next();
  if (!hasSupabaseEnv()) return next();

  const { url, publishableKey } = getSupabaseEnv();
  let response = next();

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = next();
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        Object.entries(headers).forEach(([name, value]) =>
          response.headers.set(name, value),
        );
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const isLogin = request.nextUrl.pathname.startsWith("/login");
  const isPasswordRecovery = request.nextUrl.pathname.startsWith("/forgot-password");
  const isAuthCallback = request.nextUrl.pathname.startsWith("/auth/");

  if (!signedIn && !isLogin && !isPasswordRecovery && !isAuthCallback) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return copySessionState(response, NextResponse.redirect(loginUrl));
  }

  return response;
}
