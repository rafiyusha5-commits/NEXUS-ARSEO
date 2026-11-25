import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { DRIVE_PERMISSIONS } from "@/lib/google/drive-readonly.ts";
import { createSupabaseAgentData } from "@/lib/agent/server/supabase-data.ts";
import { CatalogSync } from "@/components/assistant/catalog-sync";
import { ArchiveSearch } from "@/components/assistant/archive-search";
import { catalogOcrConfig } from "@/lib/google/catalog-ocr-config.ts";
import { CONTENT_STATUS } from "@/lib/google/catalog-text.ts";
import type { DriveFile } from "@/lib/google/drive-readonly.ts";
export const dynamic = "force-dynamic";
export default async function ArchivePage({ searchParams }: { searchParams: Promise<{ q?: string; offset?: string }> }) {
  const { profile, roles, supabase, permissions: can } = await requirePageUser([...DRIVE_PERMISSIONS, "agent.use", "documents.drive.text.view", "prices.purchase.view"]);
  const allowed = ([...DRIVE_PERMISSIONS, "agent.use"] as const).every(code => can[code]);
  const query = await searchParams;
  const q = (query.q ?? "").trim().slice(0, 120); const offset = Math.max(0, Math.min(1000, Number(query.offset) || 0));
  let result: { files:DriveFile[];total:number|null;truncated:boolean;requiredPermissions?:string[] } | undefined; let error = false;
  const run=allowed ? await supabase.from("drive_catalog_runs").select("kind,status,started_at,finished_at,pages,files,readable,unreadable").order("started_at",{ascending:false}).limit(1).maybeSingle() : null;
  if (allowed && q) { try { result = await createSupabaseAgentData(supabase).findDriveDocuments!(q,offset,AbortSignal.timeout(30000)); } catch { error = true; } }
  // Permissions are refreshed after the remote search, before any metadata is rendered.
  const required = [...DRIVE_PERMISSIONS, "agent.use", ...(result?.requiredPermissions ?? [])];
  const fresh = await loadPermissions(supabase, required);
  const visible = allowed && required.every(code => fresh[code]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="assistant" /><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Ассистент</p><h1>Архив Google Drive</h1></div><Link className="ghost button-link" href="/assistant">Вернуться к ассистенту</Link></header>
    <WorkflowHelp section="archive"/>
    {!visible ? <p>Нет права доступа к архиву Google Drive.</p> : <section className="panel admin-section">
      <p>Оригиналы из папки «02_Для дистрибьюторов KZ» остаются на Google Drive. В Nexus хранится каталог и безопасный извлечённый текст. Google Drive — только чтение.</p>
      {run?.error ? <p>Каталог недоступен. Администратору необходимо проверить миграции и серверный доступ к архиву.</p> : <>
        {run?.data ? <p>{run.data.kind === "ocr" ? "Пакет OCR" : "Обновление каталога"}: {run.data.status === "completed" ? "завершено" : run.data.status === "extracting" ? "чтение текста" : run.data.status === "failed" ? "прервано" : "обход папок"}. Файлов: {run.data.files}. Текст прочитан: {run.data.readable}. Без прочитанного текста: {run.data.unreadable}. {run.data.finished_at && `Время: ${new Date(run.data.finished_at).toLocaleString("ru-RU",{timeZone:"Asia/Aqtobe"})}`}</p> : <p>Каталог в базе ещё не создан. Запустите первое обновление.</p>}
        {can["documents.drive.text.view"] && can["prices.purchase.view"] && roles.some(role=>["administrator","director"].includes(role.code)) && <CatalogSync ocrEnabled={catalogOcrConfig().enabled} />}
      </>}
      <ArchiveSearch key={q} query={q} />
      {error && <p>Не удалось прочитать архив. Попробуйте позже.</p>}
      {result && <><p>{result.total === null ? "Поиск неполный" : `Найдено: ${result.total}`}</p><ul>{result.files.map(file => <li key={file.id}><strong>{file.name}</strong> <a href={`/assistant/archive/${file.id}`}>Скачать оригинал</a><p>{file.path}</p>{file.contentStatus&&<p>{file.textMethod === "ocr" ? "Распознано OCR · возможны ошибки" : CONTENT_STATUS[file.contentStatus]}{file.ocrError&&` · OCR: ${file.ocrError === "too_many_pages" ? "слишком много страниц" : file.ocrError === "empty" ? "текст не найден" : file.ocrError === "retry_exhausted" ? "попытки исчерпаны" : "не удалось распознать"}`}{file.modifiedTime&&` · версия источника: ${new Date(file.modifiedTime).toLocaleDateString("ru-RU",{timeZone:"Asia/Aqtobe"})}`}</p>}</li>)}</ul>
        {result.truncated && <Link href={`/assistant/archive?q=${encodeURIComponent(q)}&offset=${offset + 20}`}>Следующая страница</Link>}</>}
    </section>}
  </section></main>;
}
