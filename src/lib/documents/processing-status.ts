export const processingErrors = {
  SESSION_EXPIRED: "Сессия завершилась. Войдите снова и проверьте результат операции.",
  ACCESS_DENIED: "Недостаточно прав. Сохранённые документы не изменены этим отказом.",
  SOURCE_CHANGED: "Источник изменён или перемещён. Обновите проверку папки.",
  SOURCE_UNAVAILABLE: "Источник временно недоступен. Проверьте результат и повторите действие.",
  UNSUPPORTED: "Файл не поддерживается, повреждён или превышает допустимый размер.",
  STORAGE_FAILED: "Не удалось сохранить файл. Повтор начнётся с проверки квитанции.",
  SAVE_UNCERTAIN: "Результат сохранения пока не подтверждён. Обновите страницу: повтор сначала проверит квитанцию.",
  INTERRUPTED: "Операция прервана или её срок ожидания истёк. Проверьте результат и повторите действие.",
} as const;
export type ProcessingErrorCode = keyof typeof processingErrors;
export type ProcessingStage = "checking" | "reading" | "downloading" | "storage" | "registering" | "finished";
export function processingErrorCode(error: unknown, stage: ProcessingStage): ProcessingErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (/Недостаточно прав|Нет доступа|Нет права/.test(message)) return "ACCESS_DENIED";
  if (/изменён|перемещён|Состав папки/.test(message)) return "SOURCE_CHANGED";
  if (/Не удалось проверить файл|Не удалось проверить содержимое/.test(message)) return "UNSUPPORTED";
  if (stage === "storage") return "STORAGE_FAILED";
  if (stage === "registering" || stage === "finished") return "SAVE_UNCERTAIN";
  return "SOURCE_UNAVAILABLE";
}
export type ProcessingReceipt = { id: string; kind: string; state: string; stage: string; started_at: string; updated_at: string; lease_until: string; finished_at: string | null; error_code: ProcessingErrorCode | null };
export function processingState(receipt: ProcessingReceipt, now: number) {
  return receipt.state === "running" && Date.parse(receipt.lease_until) <= now ? "needs_action" : receipt.state;
}
export function processingDiagnostic(id: string, stage: ProcessingStage, started: number, now: number, code: ProcessingErrorCode | null) {
  return { operation_id: id, stage, duration_ms: Math.max(0, now - started), error_code: code };
}
