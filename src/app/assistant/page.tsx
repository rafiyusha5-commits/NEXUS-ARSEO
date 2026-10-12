import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { TraceTable, type TraceRun } from "@/components/assistant/trace-table";
import { DISABLED_REASON_TEXT, loadAgentConfig } from "@/lib/agent/config";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";

export const dynamic = "force-dynamic";

const RUN_COLUMNS = "id,status,channel,question_excerpt,error_code,tools,steps,tool_calls,input_tokens,output_tokens,actual_usd_micros,request_refunded,cost_status,created_at,finished_at";

export default async function AssistantPage() {
  const { profile, roles, supabase, user } = await requireUser();
  const can = await loadPermissions(supabase, ["agent.use", "agent.view_traces", "documents.drive.view"] as const);
  const config = loadAgentConfig();

  const [usageResult, runsResult] = can["agent.use"]
    ? await Promise.all([
      supabase.rpc("my_agent_usage"),
      supabase.from("agent_runs").select(RUN_COLUMNS).eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
    ])
    : [{ data: null, error: null }, { data: null, error: null }];
  const usage = (Array.isArray(usageResult.data) ? usageResult.data[0] : usageResult.data) as { requests_used?: number; request_limit?: number; budget_configured?: boolean } | null;
  const migrationMissing = Boolean(usageResult.error || runsResult.error);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="assistant" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Главная</p><h1>Ассистент</h1></div>
          <div className="topbar-actions">{can["documents.drive.view"] && <Link className="ghost button-link" href="/assistant/archive">Архив Google Drive</Link>}{can["agent.use"] && <Link className="ghost button-link" href="/assistant/telegram">Telegram</Link>}{can["agent.view_traces"] && <Link className="ghost button-link" href="/assistant/traces">Трассы сотрудников</Link>}</div>
        </header>

        {!can["agent.use"] && <div className="login-error admin-message">У вас нет права пользоваться ассистентом (agent.use).</div>}
        {can["agent.use"] && migrationMissing && <div className="setup-notice">Ассистент ещё не подготовлен в базе данных: примените миграцию 202609275200_agent_web_mvp.sql.</div>}
        {can["agent.use"] && !migrationMissing && !config.enabled && <div className="setup-notice">{DISABLED_REASON_TEXT[config.reason]}</div>}
        {can["agent.use"] && !migrationMissing && config.enabled && usage && !usage.budget_configured && (
          <div className="setup-notice">Месячный бюджет ассистента не настроен администратором, вопросы не принимаются.</div>
        )}

        {can["agent.use"] && !migrationMissing && config.enabled && usage?.budget_configured && (
          <AssistantChat initialUsed={Number(usage.requests_used ?? 0)} limit={Number(usage.request_limit ?? 0)} />
        )}

        {can["agent.use"] && !migrationMissing && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Безопасная трасса</p><h2>Мои запросы</h2></div><span className="page-count">последние 20</span></div>
            <p className="form-help">Хранятся только скрытая выдержка вопроса, использованные инструменты, безопасные параметры, расход и код ошибки. Полные вопросы и ответы не сохраняются, поэтому восстановить ответ по трассе нельзя.</p>
            <TraceTable runs={(runsResult.data ?? []) as unknown as TraceRun[]} showUser={false} />
          </section>
        )}
      </section>
    </main>
  );
}
