import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import { PortalSidebar } from "@/components/portal-sidebar";
import { requirePortalUser } from "@/lib/auth/access";
import { updatePortalProfile } from "./actions";

export default async function PortalProfilePage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const params = await searchParams;
  const { profile, user } = await requirePortalUser();
  return <main className="app-shell">
    <PortalSidebar profile={profile} active="profile" />
    <section className="workspace admin-workspace portal-workspace">
      <header className="topbar"><div><p className="eyebrow">Кабинет клиента</p><h1>Профиль</h1></div></header>
    <WorkflowHelp section="profile"/>
      {params.error && <div className="login-error admin-message">{params.error}</div>}
      {params.success && <div className="login-success admin-message">{params.success}</div>}
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Учётная запись</p><h2>{profile.full_name}</h2></div></div>
        <form action={updatePortalProfile} className="admin-form-grid">
          <label>Электронная почта<input value={user.email ?? ""} readOnly /></label>
          <label>Телефон<input name="phone" maxLength={50} defaultValue={profile.phone ?? ""} /></label>
          <label>Язык интерфейса<select name="locale" defaultValue={profile.locale}><option value="ru">Русский</option><option value="kk">Қазақша</option><option value="en">English</option></select></label>
          <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Сохранить</PendingSubmitButton>
        </form>
        <p className="form-help">Чтобы изменить ФИО, компанию или набор прав, обратитесь к менеджеру ARSEO.</p>
      </section>
    </section>
  </main>;
}
