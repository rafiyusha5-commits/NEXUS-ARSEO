import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { TelegramUpdatesTable } from "@/components/assistant/telegram-updates";
import { TraceTable, type TraceRun } from "@/components/assistant/trace-table";
import { loadedAt, type TelegramRunRow, type TelegramUpdateRow } from "@/lib/telegram/update-state.ts";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";

export const dynamic = "force-dynamic";

export default async function AssistantTracesPage() {
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, ["agent.view_traces"] as const);
  // RLS returns other employees' runs only to agent.view_traces holders; this check only hides the page.
  const [runsResult, budgetResult] = can["agent.view_traces"]
    ? await Promise.all([
      supabase.from("agent_runs")
        .select("id,status,channel,question_excerpt,error_code,tools,steps,tool_calls,input_tokens,output_tokens,actual_usd_micros,request_refunded,cost_status,created_at,finished_at,user:profiles!agent_runs_user_id_fkey(full_name)")
        .order("created_at", { ascending: false }).limit(100),
      supabase.from("agent_budget_months").select("budget_month,spent_usd_micros,input_tokens,output_tokens").order("budget_month", { ascending: false }).limit(3),
    ])
    : [{ data: null, error: null }, { data: null, error: null }];
  // Telegram messages that did not end with a delivered answer, for all employees (RLS: agent.view_traces).
  const telegramResult = can["agent.view_traces"] ? await supabase.from("telegram_updates")
    .select("update_id,status,stage,error_code,run_id,created_at,updated_at,finished_at,user:profiles!telegram_updates_user_id_fkey(full_name)")
    .or("status.neq.completed,error_code.not.is.null").order("created_at", { ascending: false }).limit(50) : null;
  const telegramUpdates = (telegramResult?.data ?? []) as unknown as TelegramUpdateRow[];
  const telegramRunIds = telegramUpdates.map((row) => row.run_id).filter((id): id is string => !!id);
  const telegramRuns = telegramRunIds.length ? await supabase.from("agent_runs").select("id,status,cost_status,request_refunded,actual_usd_micros").in("id", telegramRunIds) : null;
  const now = loadedAt();
  const months = (budgetResult.data ?? []) as Array<{ budget_month: string; spent_usd_micros: number; input_tokens: number; output_tokens: number }>;

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="assistant" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Ассистент</p><h1>Трассы сотрудников</h1></div>
          <div className="topbar-actions"><Link className="ghost button-link" href="/assistant">К ассистенту</Link></div>
        </header>
        {!can["agent.view_traces"] ? (
          <div className="login-error admin-message">Просмотр трасс других сотрудников доступен только с правом agent.view_traces.</div>
        ) : (
          <>
            {(runsResult.error || budgetResult.error) && <div className="setup-notice">Трассы недоступны: примените миграцию 202609275200_agent_web_mvp.sql.</div>}
            <section className="panel admin-section">
              <div className="panel-heading"><div><p className="eyebrow">Учёт провайдера</p><h2>Расход по месяцам</h2></div></div>
              <p className="form-help">Фактический расход по данным ответов провайдера. Это лимит ассистента Nexus, а не гарантированный предел счёта всего облачного проекта.</p>
              {months.length ? (
                <ul>{months.map((month) => <li key={month.budget_month}>{month.budget_month.slice(0, 7)}: ${(month.spent_usd_micros / 1_000_000).toFixed(4)}, токены {month.input_tokens} / {month.output_tokens}</li>)}</ul>
              ) : <div className="empty-state">Расхода пока нет.</div>}
            </section>
            <section className="panel admin-section">
              <div className="panel-heading"><div><p className="eyebrow">Последние 100</p><h2>Запросы</h2></div></div>
              <TraceTable runs={(runsResult.data ?? []) as unknown as TraceRun[]} showUser />
            </section>
            <section className="panel admin-section">
              <div className="panel-heading"><div><p className="eyebrow">Telegram · последние 50</p><h2>Незавершённые и неподтверждённые сообщения</h2></div></div>
              <p className="form-help">Прерванная обработка или неподтверждённая отправка не повторяется автоматически. Резерв прерванного запуска удерживается; спустя 10 минут следующее резервирование списывает его полностью как оценку, а позднее завершение сверяет с фактом.</p>
              {telegramResult?.error ? <div className="setup-notice">Примените миграцию 202609275400_telegram_reliability.sql.</div>
                : <TelegramUpdatesTable updates={telegramUpdates} runs={(telegramRuns?.data ?? []) as TelegramRunRow[]} now={now} showUser />}
            </section>
          </>
        )}
      </section>
    </main>
  );
}
