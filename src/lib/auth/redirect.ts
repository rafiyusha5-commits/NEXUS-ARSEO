// Where authentication may send a person back to. Audit 2026-10-13, findings Н11 and Н12.

/**
 * The path to open after the sign-in link. Only a path of this site is accepted: "/\evil.example" passed a plain
 * "starts with / but not //" check, and browsers read the backslash as a slash, so it led to another site.
 */
export function safeNextPath(requested: string | null | undefined, origin: string): string {
  if (!requested || !requested.startsWith("/") || requested.startsWith("//")) return "/";
  // A backslash or a control character has no place in a path of this application.
  if (/[\\\u0000-\u001f\u007f]/.test(requested)) return "/";
  try {
    const base = new URL(origin);
    const target = new URL(requested, base);
    if (target.origin !== base.origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

type HeaderReader = { get(name: string): string | null };
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * The address of the application for links in e-mails (password reset, invitations). APP_ORIGIN, when configured,
 * is used as is; the Origin header of the request is never used, it is whatever the caller sends. Without the
 * setting the address comes from the host the request reached, which the hosting proxy sets.
 */
export function appOrigin(env: Readonly<Record<string, string | undefined>>, headers: HeaderReader): string {
  const configured = env.APP_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) {
        return url.origin;
      }
    } catch {
      // An invalid setting falls back to the request below.
    }
  }
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim();
  if (!HOST.test(host)) return "http://localhost:3000";
  const forwarded = (headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const protocol = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
  return `${protocol}://${host.toLowerCase()}`;
}
