import "server-only";
import { createSign } from "node:crypto";
import { DRIVE_SCOPE, DriveReadonly, DriveReadError } from "./drive-readonly.ts";
let cached: { value: string; until: number } | undefined;
async function token(signal: AbortSignal): Promise<string> {
  if (cached && cached.until > Date.now() + 60000) return cached.value;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email?.endsWith(".iam.gserviceaccount.com") || !key) throw new DriveReadError();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: email, scope: DRIVE_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", cache: "no-store", signal,
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signer.sign(key).toString("base64url")}` }) });
  if (!response.ok) throw new DriveReadError();
  const data = await response.json(); if (typeof data.access_token !== "string") throw new DriveReadError();
  cached = { value: data.access_token, until: Date.now() + 3500000 }; return cached.value;
}
export const driveArchive = new DriveReadonly(token);

// Separately approved 2026 shipments root; the assistant archive root stays unchanged.
export const SHIPMENT_DRIVE_ROOT = "1ffI_2N0F9Gy3N8r5XgNRv-hipmCl1ele";
export function shipmentDrive() { return new DriveReadonly(token, fetch, SHIPMENT_DRIVE_ROOT); }
