import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { CounterpartyImportForm } from "./counterparty-import-form";

export default async function CounterpartyImportPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const { profile, roles } = await requireUser();
  const params = await searchParams;
  return <main className="app-shell">
    <AppSidebar profile={profile} roles={roles} active="counterparties" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Фаза 1 · Справочники</p><h1>Импорт контрагентов</h1></div><Link className="ghost button-link" href="/counterparties">Вернуться к реестру</Link></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}
      {params.success && <div className="login-success admin-message">{params.success}</div>}
      <CounterpartyImportForm />
    </section>
  </main>;
}
