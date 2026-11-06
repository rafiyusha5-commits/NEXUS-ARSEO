import Link from "next/link";
import { notFound } from "next/navigation";
import { PortalSidebar } from "@/components/portal-sidebar";
import { requirePortalUser } from "@/lib/auth/access";
import { formatFileSize } from "@/lib/documents/files.ts";
import { formatDate, formatDateTime } from "@/lib/documents/labels.ts";
import { isUuid } from "@/lib/documents/rules.ts";

type PortalDocument = {
  id: string; title: string; description: string | null; document_number: string | null; document_date: string | null;
  status: string; created_at: string; type_name: string; version_id: string; version_number: number;
  original_filename: string; file_size_bytes: number; uploaded_at: string;
};

export default async function PortalDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const notice = await searchParams;
  if (!isUuid(id)) notFound();
  const { supabase, profile } = await requirePortalUser();
  const { data: permissionData } = await supabase.rpc("my_external_document_permissions");
  const flags = (permissionData ?? {}) as { view?: boolean; download?: boolean };
  if (!flags.view) notFound();
  const { data: rows } = await supabase.rpc("my_external_document", { p_document_id: id });
  const document = ((rows ?? []) as PortalDocument[])[0];
  if (!document) notFound();
  await supabase.rpc("record_external_document_access", { p_document_id: id, p_action: "view" });
  return <main className="app-shell">
    <PortalSidebar profile={profile} active="documents" />
    <section className="workspace admin-workspace portal-workspace">
      <header className="topbar"><div><p className="eyebrow">{document.type_name ?? "Документ"}</p><h1>{document.title}</h1></div><Link className="ghost button-link" href="/portal/documents">К списку</Link></header>
      {notice.error && <div className="login-error admin-message">{notice.error}</div>}
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Номер</p><strong>{document.document_number || "—"}</strong></article>
        <article className="summary-card"><p>Дата документа</p><strong>{formatDate(document.document_date)}</strong></article>
        <article className="summary-card"><p>Статус</p><strong>{document.status === "approved" ? "Утверждён" : "Доступен"}</strong></article>
        <article className="summary-card"><p>Открыт</p><strong>{formatDateTime(document.created_at)}</strong></article>
      </section>
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Файл</p><h2>Опубликованная версия</h2></div></div>
        {document.description && <p className="doc-description">{document.description}</p>}
        <div className="doc-version-list"><div className="doc-version-row is-current">
          <span className="stage-number">v{document.version_number}</span><div><strong>{document.original_filename}</strong><small>{formatFileSize(document.file_size_bytes)}</small></div><div><strong>{formatDateTime(document.uploaded_at)}</strong></div>
          <div className="doc-version-actions">{flags.download ? <a className="primary button-link compact" href={`/portal/documents/${id}/download?version=${document.version_id}`}>Скачать оригинал</a> : <span className="form-help">Скачивание отключено</span>}</div>
        </div></div>
      </section>
    </section>
  </main>;
}
