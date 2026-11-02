import Link from "next/link";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { selectAll } from "@/lib/supabase/select-all";
import { folderHint, workspacePath } from "@/lib/agent/shipment-workflow";

export const dynamic = "force-dynamic";

export default async function PreparationEntry({ searchParams }: { searchParams: Promise<{ folder?: string }> }) {
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, ["agent.use", "shipments.view"] as const);
  if (!can["agent.use"] || !can["shipments.view"] || process.env.AGENT_OPERATIONS_ENABLED !== "true") redirect("/assistant");
  const folder = folderHint((await searchParams).folder);
  const { data, error } = await selectAll((from, to) => supabase.from("shipments")
    .select("id,shipment_number,project_code,status").order("created_at", { ascending: false }).order("id").range(from, to));
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="assistant" />
    <section className="workspace admin-workspace"><header className="topbar"><div><p className="eyebrow">Ассистент · подготовка</p><h1>Поставка из документов</h1></div><Link href="/assistant">Вернуться к диалогу</Link></header>
      <section className="panel admin-section"><h2>1. Выберите поставку</h2>
        <p>Сначала проверьте существующие поставки. Выбор ничего не проводит и не запускает загрузку файлов.</p>
        {folder && <p>Выбранная папка: <a href={`https://drive.google.com/drive/folders/${folder}`} target="_blank" rel="noreferrer">Открыть Google Drive</a>. Доступ и принадлежность архиву будут проверены при явной привязке.</p>}
        {error ? <p role="alert">Не удалось получить полный список. Создание новой поставки отсюда временно недоступно, чтобы не создать дубль вслепую.</p> : <>
          <ul className="workflow-choice-list">{(data ?? []).map(s => <li key={s.id}><Link href={`${workspacePath(s.id)}${folder ? `&folder=${folder}` : ""}`}>{s.shipment_number} · {s.project_code || "Без кода проекта"}</Link></li>)}</ul>
          <p>Если нужной поставки нет, заполните её основные данные. Поставщик, маршрут, склад и валюта выбираются явно.</p>
          <Link className="primary button-link" href={`/shipments?assistant=1${folder ? `&folder=${folder}` : ""}#create-shipment`}>Создать новую поставку и продолжить</Link>
        </>}
      </section>
      <section className="panel admin-section"><h2>Дальше — по шагам</h2><ol><li>Привязать папку и проверить её состав.</li><li>Сопоставить файлы, загрузить только выбранные документы.</li><li>Распознать, указать автомобиль и проверить расхождения.</li><li>Подтвердить проверенные данные. Приёмка и продажа — отдельные операции.</li></ol><p>Google Drive и Таблицы — только чтение. Уже подтверждённые данные не заменяются из-за открытия этого экрана.</p></section>
    </section></main>;
}
