import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { DRIVE_PERMISSIONS } from "@/lib/google/drive-readonly.ts";
import { driveArchive } from "@/lib/google/drive-server.ts";
export const dynamic = "force-dynamic";
export default async function ArchivePage({ searchParams }: { searchParams: Promise<{ q?: string; offset?: string }> }) {
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, [...DRIVE_PERMISSIONS, "agent.use"]);
  const allowed = ([...DRIVE_PERMISSIONS, "agent.use"] as const).every(code => can[code]);
  const query = await searchParams;
  const q = (query.q ?? "").trim().slice(0, 120); const offset = Math.max(0, Math.min(1000, Number(query.offset) || 0));
  let result: Awaited<ReturnType<typeof driveArchive.search>> | undefined; let error = false;
  if (allowed && q) { try { result = await driveArchive.search(q, AbortSignal.timeout(30000), offset); } catch { error = true; } }
  // Permissions are refreshed after the remote search, before any metadata is rendered.
  const fresh = await loadPermissions(supabase, [...DRIVE_PERMISSIONS, "agent.use"]);
  const visible = allowed && ([...DRIVE_PERMISSIONS, "agent.use"] as const).every(code => fresh[code]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="assistant" /><section className="workspace admin-workspace">
    <header className="topbar"><h1>Архив Google Drive</h1><Link href="/assistant">Ассистент</Link></header>
    {!visible ? <p>Нет права доступа к архиву Google Drive.</p> : <section className="panel admin-section">
      <p>Документы из папки «02_Для дистрибьюторов KZ» и её вложенных папок. Только чтение.</p>
      <form method="get"><label>Название или бренд <input name="q" defaultValue={q} maxLength={120} placeholder="Belgian ДС" /></label><button type="submit">Найти</button></form>
      {error && <p>Не удалось прочитать архив. Попробуйте позже.</p>}
      {result && <><p>{result.total === null ? "Поиск неполный" : `Найдено: ${result.total}`}</p><ul>{result.files.map(file => <li key={file.id}><Link href={`/assistant/archive/${file.id}`}>{file.name}</Link><p>{file.path}</p></li>)}</ul>
        {result.truncated && <Link href={`/assistant/archive?q=${encodeURIComponent(q)}&offset=${offset + 20}`}>Следующая страница</Link>}</>}
    </section>}
  </section></main>;
}
