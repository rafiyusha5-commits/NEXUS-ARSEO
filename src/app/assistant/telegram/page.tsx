import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { TelegramLink } from "@/components/assistant/telegram-link";
import { TelegramUpdatesTable } from "@/components/assistant/telegram-updates";
import { loadedAt, type TelegramRunRow, type TelegramUpdateRow } from "@/lib/telegram/update-state.ts";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { telegramConfig } from "@/lib/telegram/config.ts";
import { confirmTelegramLink, unlinkTelegram } from "./actions";

export const dynamic = "force-dynamic";
export default async function TelegramPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const { profile, roles, user, supabase } = await requireUser();
  const can = await loadPermissions(supabase, ["agent.use"] as const);
  const config = telegramConfig();
  const query = await searchParams;
  const result = can["agent.use"] ? await supabase.from("telegram_links").select("chat_id,display_name,pending_chat_id,pending_name,pending_until").eq("user_id", user.id).maybeSingle() : null;
  const link = result?.data;
  // Own messages only (RLS); state, stage and error code, never the question or the answer.
  const updatesResult = can["agent.use"] ? await supabase.from("telegram_updates")
    .select("update_id,status,stage,error_code,run_id,created_at,updated_at,finished_at").eq("user_id", user.id)
    .order("created_at", { ascending: false }).limit(10) : null;
  const updates = (updatesResult?.data ?? []) as TelegramUpdateRow[];
  const runIds = updates.map((row) => row.run_id).filter((id): id is string => !!id);
  const runsResult = runIds.length ? await supabase.from("agent_runs").select("id,status,cost_status,request_refunded,actual_usd_micros").in("id", runIds) : null;
  const now = loadedAt();
  const waiting = link?.pending_chat_id && link.pending_until;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="assistant" /><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Ассистент</p><h1>Telegram</h1></div><Link href="/assistant" className="ghost button-link">Вернуться к ассистенту</Link></header>
    {query.error && <p className="login-error">Не удалось изменить привязку. Обновите страницу или создайте новую ссылку.</p>}
    {query.success && <p className="setup-notice">{query.success === "confirmed" ? "Telegram подключён. Теперь можно задавать вопросы боту." : "Telegram отключён."}</p>}
    {!can["agent.use"] ? <p className="login-error">Нет права пользоваться ассистентом.</p> : !config ? <p className="setup-notice">Telegram ещё не настроен на сервере Nexus.</p> : result?.error ? <p className="setup-notice">Примените миграцию 202609275300_agent_telegram.sql.</p> : <>
      <section className="panel admin-section"><h2>{link?.chat_id ? "Telegram подключён" : "Подключить личный чат"}</h2>
        <p>Бот: @{config.username}. Ответы только по вашим правам. Лимит вопросов и бюджет общие с веб-чатом. Финансовые ответы доступны только с соответствующими правами. Номера удостоверений, паспортные данные и секреты не передаются. Контекст последних четырёх вопросов действует 30 минут; /new начинает новую беседу.</p>
        <p>При локальном запуске бот работает, пока компьютер и Nexus включены. Поддерживаются текстовые и голосовые вопросы до 60 секунд. Голос распознаёт OpenAI; файл в Nexus не сохраняется, расход входит в общий бюджет.</p>
        {link?.chat_id && <><p>Подключён чат: {link.display_name || "без имени"} · ID {link.chat_id}</p><form action={unlinkTelegram}><button className="ghost" type="submit">Отключить Telegram</button></form></>}
        <TelegramLink />
      </section>
      <section className="panel admin-section"><h2>Последние сообщения</h2>
        <p className="form-help">Состояние обработки без текста вопросов и ответов. Прерванные и неподтверждённые сообщения автоматически не повторяются: так не будет дубля ответа и повторного расхода. При необходимости задайте вопрос снова.</p>
        {updatesResult?.error ? <p className="setup-notice">Примените миграцию 202609275400_telegram_reliability.sql.</p>
          : <TelegramUpdatesTable updates={updates} runs={(runsResult?.data ?? []) as TelegramRunRow[]} now={now} />}
      </section>
      {waiting && <section className="panel admin-section"><h2>Подтвердите свой Telegram-чат</h2><p>Запрос от {link.pending_name || "пользователя без имени"} · ID {link.pending_chat_id}. Подтверждайте только свой чат. Подтверждение действует 10 минут после нажатия «Начать» в боте; если срок истёк, создайте новую ссылку.</p>
        <form action={confirmTelegramLink}><button className="primary" type="submit">Подтвердить этот чат</button></form></section>}
    </>}
  </section></main>;
}
