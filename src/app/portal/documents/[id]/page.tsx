import Link from "next/link";
import { notFound } from "next/navigation";
import { PortalSidebar } from "@/components/portal-sidebar";
import { requirePortalUser } from "@/lib/auth/access";
import { formatFileSize } from "@/lib/documents/files.ts";
import { formatDate, formatDateTime } from "@/lib/documents/labels.ts";
import { isUuid } from "@/lib/documents/rules.ts";

export default async function PortalDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const notice = await searchParams;
  if (!isUuid(id)) notFound();
  const { supabase, profile } = await requirePortalUser();
  const { data: permissionData } = await supabase.rpc("my_external_document_permissions");
  const flags = (permissionData ?? {}) as { view?: boolean; download?: boolean };
  if (!flags.view) notFound();
  const [{ data: document }, { data: versions }] = await Promise.all([
    supabase.from("documents").select("id,title,description,document_number,document_date,status,created_at,original_filename,file_size_bytes,type:document_types(name_ru)").eq("id", id).maybeSingle(),
    supabase.from("document_versions").select("id,version_number,original_filename,file_size_bytes,uploaded_at,is_current").eq("document_id", id).order("version_number", { ascending: false }),
  ]);
  if (!document) notFound();
  await supabase.rpc("record_external_document_access", { p_document_id: id, p_action: "view" });
  const type = Array.isArray(document.type) ? document.type[0] : document.type;
  return <main className="app-shell">
    <PortalSidebar profile={profile} active="documents" />
    <section className="workspace admin-workspace portal-workspace">
      <header className="topbar"><div><p className="eyebrow">{type?.name_ru ?? "Документ"}</p><h1>{document.title}</h1></div><Link className="ghost button-link" href="/portal/documents">К списку</Link></header>
      {notice.error && <div className="login-error admin-message">{notice.error}</div>}
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Номер</p><strong>{document.document_number || "—"}</strong></article>
        <article className="summary-card"><p>Дата документа</p><strong>{formatDate(document.document_date)}</strong></article>
        <article className="summary-card"><p>Статус</p><strong>{document.status === "approved" ? "Утверждён" : "Доступен"}</strong></article>
        <article className="summary-card"><p>Открыт</p><strong>{formatDateTime(document.created_at)}</strong></article>
      </section>
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Файлы</p><h2>Версии документа</h2></div></div>
        {document.description && <p className="doc-description">{document.description}</p>}
        <div className="doc-version-list">{(versions ?? []).map((version) => <div className={`doc-version-row${version.is_current ? " is-current" : ""}`} key={version.id}>
          <span className="stage-number">v{version.version_number}</span><div><strong>{version.original_filename}</strong><small>{formatFileSize(version.file_size_bytes)}</small></div><div><strong>{formatDateTime(version.uploaded_at)}</strong></div>
          <div className="doc-version-actions">{flags.download ? <a className="primary button-link compact" href={`/portal/documents/${id}/download?version=${version.id}`}>Скачать</a> : <span className="form-help">Скачивание отключено</span>}</div>
        </div>)}</div>
      </section>
    </section>
  </main>;
}
