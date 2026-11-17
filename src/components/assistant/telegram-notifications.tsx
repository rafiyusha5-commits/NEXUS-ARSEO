import { PendingSubmitButton } from "@/components/pending-submit-button";
import { saveTelegramNotifications } from "@/app/assistant/telegram/actions";
import { TELEGRAM_NOTIFICATION_TEXT } from "@/lib/telegram/notifications";

export type TelegramNotificationSettings = { enabled: boolean; types: string[]; available: string[]; linked: boolean };

/** The employee's own choice: deliver Nexus notifications to the linked chat. Off until the employee turns it on. */
export function TelegramNotifications({ settings }: { settings: TelegramNotificationSettings }) {
  return <section className="panel admin-section"><h2>Уведомления в Telegram</h2>
    <p className="form-help">Бот пришлёт в ваш личный чат короткий текст и ссылку на объект — только по уведомлениям, которые требуют вашего действия. Цены, суммы и тексты документов в Telegram не отправляются. С 21:00 до 08:00 по времени Казахстана сообщения не приходят: утром — одним сообщением. Одно и то же напоминание по одному объекту — не чаще раза в сутки.</p>
    {!settings.linked ? <p className="setup-notice">Сначала подключите личный чат выше.</p> : <form action={saveTelegramNotifications} className="reference-form">
      <label className="check-label"><input type="checkbox" name="enabled" defaultChecked={settings.enabled}/> Присылать уведомления в Telegram</label>
      {settings.available.map(type => <label className="check-label" key={type}><input type="checkbox" name="types" value={type} defaultChecked={settings.types.includes(type)}/> {TELEGRAM_NOTIFICATION_TEXT[type] ?? type}</label>)}
      <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить</PendingSubmitButton>
    </form>}
  </section>;
}

export type TelegramDeliveryOverview = {
  enabled_users: Array<{ name: string | null; types: string[]; linked: boolean }>;
  queued: number; sending: number; oldest_queued: string | null; last_24h: Record<string, number>;
  recent_errors: Array<{ at: string; status: string; error: string }>;
};

const statusText: Record<string, string> = { sent: "отправлено", skipped: "пропущено", failed: "ошибка", queued: "в очереди", sending: "отправляется" };
const errorText: Record<string, string> = {
  throttled: "повтор за сутки", disabled: "доставка выключена", type_not_selected: "тип не выбран", chat_not_linked: "чат отвязан",
  no_access: "нет доступа к объекту", outcome_unknown: "результат неизвестен, не повторяется", stale_summarized: "устарело, в сводке",
  rejected: "Telegram отказал", TELEGRAM_RATE_LIMIT: "ограничение Telegram", TELEGRAM_UNREACHABLE: "Telegram недоступен",
};

/** «Состояние системы»: the queue, the last day and the last errors; who has delivery on (read only). */
export function TelegramDeliveryHealth({ data }: { data: TelegramDeliveryOverview }) {
  const day = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(value));
  return <section className="panel admin-section"><h2>Уведомления в Telegram</h2>
    <p>В очереди: {data.queued}{data.oldest_queued ? ` (самое старое — ${day(data.oldest_queued)})` : ""} · отправляется: {data.sending}. За сутки: {Object.entries(data.last_24h).map(([status, count]) => `${statusText[status] ?? status} ${count}`).join(", ") || "нет"}.</p>
    <p className="form-help">Отправляет локальный процесс бота, пока он запущен. Включает доставку только сам сотрудник; здесь видно, у кого она включена.</p>
    {data.recent_errors.length > 0 && <div className="reference-list">{data.recent_errors.map((row, index) => <article className="reference-row" key={index}><div><strong>{statusText[row.status] ?? row.status}</strong><small>{day(row.at)}</small></div><span className="reference-meta">{errorText[row.error.replace(/^retries_exhausted:/, "")] ?? row.error}{row.error.startsWith("retries_exhausted:") ? " · попытки исчерпаны" : ""}</span></article>)}</div>}
    <h3>Включили доставку</h3>
    {data.enabled_users.length ? <div className="reference-list">{data.enabled_users.map((user, index) => <article className="reference-row" key={index}><div><strong>{user.name ?? "—"}</strong><small>{user.types.map(type => TELEGRAM_NOTIFICATION_TEXT[type] ?? type).join(", ")}</small></div><span className="reference-meta">{user.linked ? "чат подключён" : "чат отвязан"}</span></article>)}</div> : <p className="empty-state">Пока никто не включил.</p>}
  </section>;
}
