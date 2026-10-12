// How a Telegram update looks in Nexus. Derived from stored state only; nothing is retried from here.
export const STALE_AFTER_MS = 10 * 60_000;

export type TelegramUpdateRow = {
  update_id: number; status: string; stage: string; error_code: string | null; run_id: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
};
export type TelegramRunRow = { id: string; status: string; cost_status: string; request_refunded: boolean; actual_usd_micros: number };
export type TelegramUpdateState = { label: string; detail: string; tone: "ok" | "warning" | "error" | "progress" };

const STAGE: Record<string, string> = {
  received: "получение", session: "вход сотрудника", speech: "распознавание голоса", model: "подготовка ответа",
  access_check: "проверка доступа", sending: "отправка в Telegram", done: "завершено",
};

const ERROR: Record<string, string> = {
  ANSWER_WITHHELD: "доступ отозван или привязка изменена, ответ с данными не отправлен",
  DEADLINE_EXCEEDED: "не хватило времени, вопрос не начат и не засчитан",
  PROCESSING_ERROR: "ошибка обработки, отправлено сообщение без данных",
  TELEGRAM_REJECTED: "Telegram отказал (например, бот заблокирован)",
  TELEGRAM_RATE_LIMIT: "Telegram ограничил частоту сообщений",
  TELEGRAM_UNAVAILABLE: "Telegram не ответил",
  AGENT_DAILY_LIMIT: "лимит вопросов на сегодня исчерпан",
  AGENT_MONTHLY_BUDGET: "месячный бюджет исчерпан",
  AGENT_SPEECH_ERROR: "голос не распознан",
};

function cost(run: TelegramRunRow | undefined, stale: boolean): string {
  if (!run) return "";
  if (run.cost_status === "reserved") return stale ? "Резерв бюджета удерживается до сверки: расход неизвестен." : "";
  if (run.cost_status === "estimated") return "Расход учтён по полному резерву (оценка): фактический расход неизвестен.";
  const money = `Расход учтён: $${(run.actual_usd_micros / 1_000_000).toFixed(4)}.`;
  return run.request_refunded ? `${money} Вопрос не засчитан в дневной лимит.` : money;
}

export function telegramUpdateState(row: TelegramUpdateRow, run: TelegramRunRow | undefined, now: number): TelegramUpdateState {
  const stale = Date.parse(row.updated_at) < now - STALE_AFTER_MS;
  const reason = row.error_code ? ERROR[row.error_code] ?? `код ${row.error_code}` : "";
  const with_ = (text: string) => [text, cost(run, stale)].filter(Boolean).join(" ");
  if (row.status === "completed") {
    if (!row.error_code) return { label: "Ответ доставлен", detail: with_(""), tone: "ok" };
    return { label: "Отправлено сообщение без ответа", detail: with_(`Причина: ${reason}.`), tone: "warning" };
  }
  if (row.status === "failed") return { label: "Не доставлено", detail: with_(reason ? `Причина: ${reason}.` : "Telegram не принял сообщение."), tone: "error" };
  if (row.status === "delivery_unknown") {
    return { label: "Неизвестно, доставлен ли ответ", detail: with_("Telegram не подтвердил отправку. Повторно ответ не отправляется, чтобы не прислать дубль."), tone: "warning" };
  }
  if (row.status === "delivery_started") {
    return stale
      ? { label: "Отправка прервана", detail: with_("Неизвестно, доставлен ли ответ. Автоматически не повторяется."), tone: "warning" }
      : { label: "Отправляется", detail: "", tone: "progress" };
  }
  // processing
  const stage = STAGE[row.stage] ?? row.stage;
  if (!stale) return { label: "Обрабатывается", detail: `Этап: ${stage}.`, tone: "progress" };
  return {
    label: "Обработка прервана",
    detail: with_(`Остановилось на этапе «${stage}». Результат неизвестен; вопрос и платные запросы автоматически не повторяются. При необходимости задайте вопрос снова.`),
    tone: "error",
  };
}

/** Time the page data was loaded; states older than STALE_AFTER_MS relative to it count as interrupted. */
export function loadedAt(): number {
  return Date.now();
}
