import { createPublicKey, verify } from "node:crypto";
import type { Environment } from "./policy.ts";

export type BackupEvidence = { environment: Environment; copiedAt: string; integrityAt: string | null; restoredAt: string | null; restorePassed: boolean; archiveSha256: string };
// Detached Ed25519 signature of the exact UTF-8 payload. The app receives only a public key.
export function verifyBackup(text: string, publicKey: string, expected: Environment, now = Date.now()): BackupEvidence | null {
  try {
    if (Buffer.byteLength(text) > 8192) return null;
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return null;
    const envelope = JSON.parse(text);
    if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string" || !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, "base64"))) return null;
    const p = JSON.parse(envelope.payload);
    const fields = ["environment", "copiedAt", "integrityAt", "restoredAt", "restorePassed", "archiveSha256"];
    if (Object.keys(p).length !== fields.length || Object.keys(p).some(k => !fields.includes(k)) || p.environment !== expected || typeof p.restorePassed !== "boolean" || !/^[0-9a-f]{64}$/.test(p.archiveSha256)) return null;
    const validDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now;
    if (!validDate(p.copiedAt) || (p.integrityAt !== null && !validDate(p.integrityAt)) || (p.restoredAt !== null && !validDate(p.restoredAt))) return null;
    if (p.integrityAt && Date.parse(p.integrityAt) < Date.parse(p.copiedAt)) return null;
    if (p.restoredAt && (!p.integrityAt || Date.parse(p.restoredAt) < Date.parse(p.integrityAt))) return null;
    if (p.restorePassed && !p.restoredAt) return null;
    return p as BackupEvidence;
  } catch { return null; }
}
