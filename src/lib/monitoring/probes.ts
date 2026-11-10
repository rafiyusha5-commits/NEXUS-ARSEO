import { randomUUID } from "node:crypto";
import type { Code, Observation } from "./policy.ts";

export type ProbeConfig = { url?: string; key?: string; bucket?: string; object?: string; sha256?: string };
export type ProbeResult = { observedAt: string; checks: Observation[]; ready: boolean };
export type Fetcher = typeof fetch;
const stamp = (component: "database" | "storage", code: Code): Observation => ({ component, code, observedAt: new Date().toISOString(), correlation: randomUUID() });

export async function probeDependencies(config: ProbeConfig, request: Fetcher = fetch, budgetMs = 4000): Promise<ProbeResult> {
  let origin: URL;
  try { origin = new URL(config.url || ""); if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) throw Error(); }
  catch { return { observedAt: new Date().toISOString(), checks: [stamp("database", "NOT_CONFIGURED"), stamp("storage", "NOT_CONFIGURED")], ready: false }; }
  if (!config.key) return { observedAt: new Date().toISOString(), checks: [stamp("database", "NOT_CONFIGURED"), stamp("storage", "NOT_CONFIGURED")], ready: false };
  const controller = new AbortController();
  const deadline = Math.min(4000, Math.max(10, budgetMs));
  const headers = { apikey: config.key, Authorization: `Bearer ${config.key}` };
  async function check(component: "database" | "storage"): Promise<Observation> {
    if (component === "storage" && (!config.bucket || !config.object || !/^[a-f0-9]{64}$/.test(config.sha256 || ""))) return stamp(component, "NOT_CONFIGURED");
    try {
      const path = component === "database" ? "/rest/v1/rpc/system_health_ping" : `/storage/v1/object/authenticated/${encodeURIComponent(config.bucket!)}/${config.object!.split("/").map(encodeURIComponent).join("/")}`;
      const response = await request(new URL(path, origin), { method: "GET", headers, signal: controller.signal, redirect: "error", cache: "no-store" });
      if (!response.ok) { await response.body?.cancel(); return stamp(component, "UNAVAILABLE"); }
      // Read at most 4 KiB, including streamed/chunked responses. A success header alone is insufficient.
      const reader = response.body?.getReader();
      if (!reader) return stamp(component, "UNAVAILABLE");
      const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 4096) return stamp(component, "UNAVAILABLE"); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks);
      if (component === "database") return stamp(component, body.toString("utf8").trim() === "true" ? "OK" : "UNAVAILABLE");
      const { createHash } = await import("node:crypto");
      return stamp(component, createHash("sha256").update(body).digest("hex") === config.sha256 ? "OK" : "UNAVAILABLE");
    } catch { return stamp(component, controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE"); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = new Map<string, Observation>();
  const work = Promise.all((["database", "storage"] as const).map(async component => { const result = await check(component); completed.set(component, result); return result; }));
  const timeout = new Promise<Observation[]>(resolve => { timer = setTimeout(() => { controller.abort(); resolve((["database", "storage"] as const).map(component => completed.get(component) ?? stamp(component, "TIMEOUT"))); }, deadline); });
  try {
    const checks = await Promise.race([work, timeout]);
    return { observedAt: new Date().toISOString(), checks, ready: checks.every(c => c.code === "OK") };
  } finally { clearTimeout(timer); controller.abort(); }
}

// Per-process single flight and a five-second cooldown bound public polling costs.
export function cachedProbe(run: () => Promise<ProbeResult>, now = Date.now) {
  let pending: Promise<ProbeResult> | null = null; let cached: ProbeResult | null = null; let until = 0;
  return async () => {
    if (cached && now() < until) return cached;
    if (pending) return pending;
    pending = run().then(result => { cached = result; until = now() + 5000; return result; }).finally(() => { pending = null; });
    return pending;
  };
}
