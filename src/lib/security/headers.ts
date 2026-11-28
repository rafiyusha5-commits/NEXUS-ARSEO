// Security headers (audit 2026-11-11, K11). The Content-Security-Policy is built per request in src/proxy.ts with a
// fresh nonce: scripts run only from this origin or with that nonce ('strict-dynamic' lets them load their own
// chunks), so an injected inline script does not run. Next.js reads the policy from the request and puts the nonce
// on its own scripts; the root layout reads the request headers, so every page is rendered per request.
//
// style-src keeps 'unsafe-inline': React style attributes cannot carry a nonce, and the interface uses a few of them.
// Inline styles cannot run code; scripts are what the policy has to stop.

export const NONCE_HEADER = "x-nonce";

/** A random nonce for one response: 16 bytes, base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The policy for one response. Development adds 'unsafe-eval' for the Next.js dev runtime (React Refresh) only. */
export function contentSecurityPolicy(nonce: string, development = false): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(nonce)) throw new Error("Invalid CSP nonce");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

// The other headers are static and set for every response in next.config.ts. The policy is not among them: a second
// policy there would apply to pages too, and browsers enforce both.
export const applicationSecurityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // The camera only for Nexus itself (the scanner of the mobile warehouse, 202611280500); never for embedded content.
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(), microphone=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
] as const;
