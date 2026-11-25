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
    if (target.origin !== base.origin || target.pathname.startsWith("//")) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

type HeaderReader = { get(name: string): string | null };
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * The address of the application for links in e-mails (password reset, invitations). APP_ORIGIN, when configured,
 * is used as is. Production never derives an email destination from request headers.
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
      // Fail closed below; a bad setting must not delegate trust to request headers.
    }
    throw new Error("Некорректный APP_ORIGIN: укажите адрес Nexus без пути");
  }
  if (env.NODE_ENV === "production") throw new Error("Для ссылок входа требуется APP_ORIGIN");
  const host = (headers.get("host") ?? "").trim();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  if (!HOST.test(host) || !local) throw new Error("Для ссылок входа требуется APP_ORIGIN");
  return `http://${host.toLowerCase()}`;
}

// One-time links of Supabase Auth e-mails (invitation, password recovery) open /auth/callback with a token hash. The
// e-mail templates of the project build them: «{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite…»
// (docs/auth-email-links.md). An invitation sent by the server key cannot use the PKCE «code» flow.
const EMAIL_OTP_TYPES = ["invite", "recovery", "signup", "email", "magiclink", "email_change"] as const;
export type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

/** The link's verification: a token hash of a known type, or nothing. */
export function emailLinkToken(tokenHash: string | null | undefined, type: string | null | undefined): { tokenHash: string; type: EmailOtpType } | null {
  if (!tokenHash || !/^[A-Za-z0-9_-]{8,512}$/.test(tokenHash)) return null;
  return EMAIL_OTP_TYPES.includes(type as EmailOtpType) ? { tokenHash, type: type as EmailOtpType } : null;
}

/** Where the link leads after the session is open: invitations and recovery always end with setting a password. */
export function emailLinkNext(type: EmailOtpType, requested: string): string {
  return type === "invite" || type === "recovery" ? "/update-password" : requested;
}
