import "server-only";
import { readFile, stat } from "node:fs/promises";
import { cachedProbe, probeDependencies } from "./probes";
import { environment, configuredJobPolicy } from "./policy";
import { verifyBackup } from "./backup";

export const getReadiness = cachedProbe(() => probeDependencies({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.MONITORING_SERVICE_KEY,
  bucket: process.env.MONITORING_STORAGE_BUCKET,
  object: process.env.MONITORING_STORAGE_OBJECT,
  sha256: process.env.MONITORING_STORAGE_SHA256,
}));
export function monitoringEnvironment() { return environment(process.env.MONITORING_ENVIRONMENT); }
export function jobPolicy(component: "drive" | "ocr" | "telegram") { return configuredJobPolicy(component,process.env); }
export async function backupEvidence() {
  const env = monitoringEnvironment(), path = process.env.MONITORING_BACKUP_MANIFEST, key = process.env.MONITORING_BACKUP_PUBLIC_KEY;
  if (!env || !path || !key) return null;
  try { if ((await stat(path)).size > 8192) return null; return verifyBackup(await readFile(path, "utf8"), key, env); }
  catch { return null; }
}
