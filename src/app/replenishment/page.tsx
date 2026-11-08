import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth/access";
import { AppSidebar } from "@/components/app-sidebar";
import { ReplenishmentWorkspace } from "@/components/replenishment-workspace";
import { parseWorkspace, uuid } from "@/lib/replenishment/workspace";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import * as actions from "./actions";
export default async function ReplenishmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const runId = uuid(params.run);
  const { data, error } = await supabase.rpc("replenishment_workspace", { p_profile_id: uuid(params.profile), p_run_id: runId });
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="replenishment"/><section className="workspace admin-workspace replenishment-workspace">
    {error ? <div className="setup-notice"><h1>Автозаказ Казахстан</h1><p>{ruleViolationMessage(error, "Не удалось загрузить данные автозаказа. Проверьте доступ и миграцию.")}</p></div> : <ReplenishmentWorkspace workspace={parseWorkspace(data)} runId={runId} requestId={randomUUID()} actions={actions} message={typeof params.message === "string" ? params.message : undefined}/>}
  </section></main>;
}
