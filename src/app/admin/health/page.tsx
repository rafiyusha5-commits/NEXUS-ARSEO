import Link from "next/link";
import { TelegramDeliveryHealth, type TelegramDeliveryOverview } from "@/components/assistant/telegram-notifications";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { getReadiness, monitoringEnvironment, backupEvidence, jobPolicy } from "@/lib/monitoring/runtime";
import { componentLabels, labels, jobCode, type Component, type Code, type JobFacts } from "@/lib/monitoring/policy";

type Incident = { id: string; component: Component; code: Code; correlation: string; first_at: string; last_at: string; recovered_at: string | null; occurrences: number };
const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }) : "Не подтверждено";
export default async function HealthPage({ searchParams }: { searchParams: Promise<{ offset?: string }> }) {
  const { profile, roles, supabase, permissions: permission } = await requirePageUser(["system.health.view"]);
  const shell = (content: React.ReactNode) => <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="health"/><section className="workspace admin-workspace"><header className="topbar"><div><p className="eyebrow">Администрирование</p><h1>Состояние системы</h1></div></header>{content}</section></main>;
  if (!permission["system.health.view"]) return shell(<p className="login-error">Нет доступа к диагностике.</p>);
  const env = monitoringEnvironment();
  if (!env) return shell(<p className="setup-notice">Мониторинг этой среды ещё не настроен. Рабочие операции не изменены.</p>);
  const query = await searchParams;
  const offset = /^\d{1,7}$/.test(query.offset || "") ? Math.min(1000000, Number(query.offset)) : 0;
  const [probe, backup, snapshot, jobs, telegram] = await Promise.all([getReadiness(), backupEvidence(), supabase.rpc("system_health_snapshot", { p_environment: env, p_offset: offset }), supabase.rpc("system_health_jobs"), supabase.rpc("telegram_notification_overview")]);
  const incidents = (snapshot.data?.incidents || []) as Incident[];
  const facts = jobs.data as Record<"drive" | "ocr" | "telegram", JobFacts> | null;
  return shell(<>
    <p className="form-help">Среда: {env}. Время — Казахстан. Открытие страницы ничего не перезапускает. <Link href="/admin/health">Обновить состояние</Link></p>
    <section className="panel admin-section"><h2>Приложение и зависимости</h2><p>Приложение отвечает. Проверено {date(probe.observedAt)}.</p><div className="reference-list">{probe.checks.map(c => <article className="reference-row" key={c.component}><strong>{componentLabels[c.component]}</strong><span>{labels[c.code]}</span></article>)}</div><p className="form-help">Проверяется реальное чтение базы и контрольного файла. Не настроенная проверка не означает исправность.</p></section>
    <section className="panel admin-section"><h2>Обработка документов и сообщения</h2>{jobs.error || !facts ? <p className="login-error">Состояние заданий получить не удалось.</p> : <div className="reference-list">{(["drive", "ocr", "telegram"] as const).map(key => { const f = facts[key]; const code = jobCode(f, jobPolicy(key), Date.parse(probe.observedAt)); return <article className="reference-row reference-row-stack" key={key}><strong>{componentLabels[key]} · {code === "OK" ? "Последняя обработка успешна" : labels[code]}</strong><small>Последняя попытка: {date(f.lastAttempt)}. Последний успех: {date(f.lastSuccess)}.</small><span>В работе: {f.running}; требуется действие: {f.needsAction + f.expired}; ошибок: {f.failed}.</span></article>; })}</div>}<p className="form-help">Это результаты обработки в Nexus, а не проверка доступности внешнего сервиса в данный момент.</p><Link href="/integrations">Открыть журнал интеграций</Link></section>
    {telegram.data && <TelegramDeliveryHealth data={telegram.data as TelegramDeliveryOverview}/>}
    <section className="panel admin-section"><h2>Резервная копия</h2>{!backup ? <p>Не подтверждено: нет проверенного отчёта для этой среды.</p> : <><p>Копия: {date(backup.copiedAt)}. Целостность: {date(backup.integrityAt)}.</p><p>Восстановление: {backup.restorePassed ? date(backup.restoredAt) : "Не подтверждено"}.</p>{Date.parse(probe.observedAt) - Date.parse(backup.copiedAt) > 86400000 && <p className="login-error">Копия старше 24 часов. Это технический порог; рабочую политику утверждает владелец.</p>}</>}<p className="form-help">Успешная копия и успешное восстановление — разные проверки.</p></section>
    <section className="panel admin-section"><h2>Инциденты</h2>{snapshot.error ? <p className="login-error">Журнал недоступен. Отсутствие ответа не означает отсутствие ошибок.</p> : <><p>Внешняя доставка: ожидает {snapshot.data?.delivery?.queued ?? 0}; не доставлено {snapshot.data?.delivery?.failed ?? 0}. Канал включается отдельно.</p><div className="reference-list">{incidents.slice(0,50).map(i => <article className="reference-row reference-row-stack" key={i.id}><strong>{componentLabels[i.component]} · {labels[i.code]}</strong><span>{i.recovered_at ? `Восстановлено ${date(i.recovered_at)}` : "Открыт"}; повторов: {i.occurrences}.</span><small>{date(i.first_at)} — {date(i.last_at)}</small><small>Код обращения: {i.correlation}</small></article>)}</div>{!incidents.length && <p>Сохранённых инцидентов на этой странице нет. Наблюдатель запускается отдельно.</p>}{offset>0 && <Link href={`/admin/health?offset=${Math.max(0,offset-50)}`}>Предыдущие</Link>}{incidents.length>50 && <Link href={`/admin/health?offset=${offset+50}`}>Следующие</Link>}</>}</section>
  </>);
}
