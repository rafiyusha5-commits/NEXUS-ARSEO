export const components = ["app", "database", "storage", "drive", "ocr", "telegram", "backup"] as const;
export type Component = typeof components[number];
export const codes = ["OK", "UNAVAILABLE", "TIMEOUT", "NOT_CONFIGURED", "FAILED", "STALE", "NEEDS_ACTION", "UNVERIFIED", "DISABLED", "MANUAL", "IDLE", "RUNNING", "RETRY"] as const;
export type Code = typeof codes[number];
export type Environment = "test" | "production" | "training" | "recovery";
export type Observation = { component: Component; code: Code; observedAt: string; correlation: string };
export const failures = new Set<Code>(["UNAVAILABLE", "TIMEOUT", "FAILED", "STALE"]);
export const labels: Record<Code, string> = {
  OK: "Доступно", UNAVAILABLE: "Недоступно", TIMEOUT: "Нет ответа вовремя", NOT_CONFIGURED: "Не настроено",
  FAILED: "Ошибка", STALE: "Просрочено", NEEDS_ACTION: "Требуется действие сотрудника", UNVERIFIED: "Не подтверждено",
  DISABLED: "Выключено", MANUAL: "Ручной запуск", IDLE: "Нет работы", RUNNING: "Выполняется", RETRY: "Ожидает повторения",
};
export const componentLabels: Record<Component, string> = { app: "Приложение", database: "База данных", storage: "Файлы", drive: "Google Drive", ocr: "Распознавание", telegram: "Telegram", backup: "Резервная копия" };
export function environment(value: unknown): Environment | null {
  return typeof value === "string" && ["test", "production", "training", "recovery"].includes(value) ? value as Environment : null;
}
// Rebuild from a closed vocabulary; never serialize the original error or request.
export function safeObservation(input: unknown): Observation | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  if (!components.includes(v.component as Component) || !codes.includes(v.code as Code)) return null;
  if (typeof v.correlation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.correlation)) return null;
  if (typeof v.observedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.observedAt) || !Number.isFinite(Date.parse(v.observedAt))) return null;
  return { component: v.component as Component, code: v.code as Code, observedAt: v.observedAt, correlation: v.correlation };
}
export type JobFacts = { queued: number; running: number; retry: number; needsAction: number; failed: number; expired: number; lastSuccess: string | null; lastAttempt: string | null };
export type JobPolicy = { mode: "disabled" | "manual" | "scheduled" | "unconfigured"; intervalSeconds: number; graceSeconds: number };
export function configuredJobPolicy(component: "drive" | "ocr" | "telegram", config: Record<string,string|undefined>): JobPolicy {
  const mode=config[`MONITORING_${component.toUpperCase()}_MODE`];
  const interval=Number(config[`MONITORING_${component.toUpperCase()}_INTERVAL_SECONDS`]||300);
  const valid=["disabled","manual","scheduled"].includes(mode||"")&&Number.isInteger(interval)&&interval>=60&&interval<=604800;
  return {mode:valid?mode as JobPolicy["mode"]:"unconfigured",intervalSeconds:valid?interval:300,graceSeconds:120};
}
export function jobCode(facts: JobFacts, policy: JobPolicy, now = Date.now()): Code {
  if (policy.mode === "unconfigured") return "NOT_CONFIGURED";
  if (policy.mode === "disabled") return "DISABLED";
  if (facts.expired > 0 || facts.needsAction > 0) return "NEEDS_ACTION";
  if (facts.running > 0) return "RUNNING";
  const attempt = facts.lastAttempt ? Date.parse(facts.lastAttempt) : NaN;
  const success = facts.lastSuccess ? Date.parse(facts.lastSuccess) : NaN;
  if (facts.failed > 0 && (!Number.isFinite(success) || attempt > success)) return "FAILED";
  if (facts.retry > 0) return "RETRY";
  if (facts.queued > 0) {
    if (policy.mode === "scheduled" && Number.isFinite(attempt) && now - attempt > (policy.intervalSeconds + policy.graceSeconds) * 1000) return "STALE";
    return "RETRY";
  }
  if (policy.mode === "manual") return Number.isFinite(success) ? "OK" : "MANUAL";
  if (!Number.isFinite(attempt)) return "UNVERIFIED";
  if (now - attempt > (policy.intervalSeconds + policy.graceSeconds) * 1000) return "STALE";
  return "IDLE";
}
