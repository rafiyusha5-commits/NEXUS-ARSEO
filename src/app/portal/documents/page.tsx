import Link from "next/link";
import { PortalSidebar } from "@/components/portal-sidebar";
import { requirePortalUser } from "@/lib/auth/access";
import { DOCUMENT_FILE_ACCEPT, DOCUMENT_FILE_TYPES_LABEL, MAX_DOCUMENT_FILE_SIZE_LABEL } from "@/lib/documents/files.ts";
import { formatDate, formatDateTime } from "@/lib/documents/labels.ts";
import { uploadPortalDocument } from "./actions";

type Flags = { view: boolean; download: boolean; upload: boolean };
type PortalDocument = { id: string; title: string; document_number: string | null; document_date: string | null; created_at: string; original_filename: string; status: string; type_name: string };

export default async function PortalDocumentsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const params = await searchParams;
  const { supabase, profile } = await requirePortalUser();
  const [{ data: permissionData }, { data: types }] = await Promise.all([
    supabase.rpc("my_external_document_permissions"),
    supabase.from("document_types").select("id, name_ru").eq("is_active", true).order("sort_order"),
  ]);
  const flags = (permissionData ?? { view: false, download: false, upload: false }) as Flags;
  const { data: documents } = flags.view
    ? await supabase.rpc("my_external_documents")
    : { data: [] };
  const visibleDocuments = (documents ?? []) as PortalDocument[];

  return <main className="app-shell">
    <PortalSidebar profile={profile} active="documents" />
    <section className="workspace admin-workspace portal-workspace">
      <header className="topbar"><div><p className="eyebrow">Кабинет клиента</p><h1>Документы</h1></div><span className="page-count">{visibleDocuments.length} документов</span></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}
      {params.success && <div className="login-success admin-message">{params.success}</div>}
      {!flags.view && <section className="panel admin-section"><div className="empty-state">Просмотр документов не разрешён. Обратитесь к менеджеру ARSEO.</div></section>}
      {flags.view && <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Открытые материалы</p><h2>Документы вашей компании</h2></div></div>
        <div className="doc-list portal-doc-list">
          {visibleDocuments.map((doc) => {
            return <Link className="doc-row" href={`/portal/documents/${doc.id}`} key={doc.id}>
              <div className="doc-main"><span className="doc-type">{doc.type_name ?? "Документ"}</span><strong>{doc.title}</strong><small>{doc.original_filename ?? "Файл"}</small></div>
              <div><strong>{doc.document_number || "Без номера"}</strong><small>{formatDate(doc.document_date)}</small></div>
              <div><strong>{doc.status === "approved" ? "Утверждён" : "Доступен"}</strong><small>{formatDateTime(doc.created_at)}</small></div>
            </Link>;
          })}
          {!visibleDocuments.length && <div className="empty-state">ARSEO пока не открыл документы для вашей компании.</div>}
        </div>
      </section>}
      {flags.upload && <section className="panel admin-section" id="upload">
        <div className="panel-heading"><div><p className="eyebrow">Передать в ARSEO</p><h2>Загрузить документ</h2></div></div>
        <form action={uploadPortalDocument} className="doc-form">
          <label>Тип<select name="document_type_id" required defaultValue=""><option value="" disabled>Выберите тип</option>{(types ?? []).map((type) => <option key={type.id} value={type.id}>{type.name_ru}</option>)}</select></label>
          <label className="doc-form-wide">Название<input name="title" maxLength={300} required /></label>
          <label>Номер<input name="document_number" maxLength={120} /></label>
          <label>Дата<input name="document_date" type="date" /></label>
          <label>Язык<select name="language" defaultValue=""><option value="">Не указан</option><option value="ru">Русский</option><option value="kk">Қазақша</option><option value="en">English</option><option value="other">Другой</option></select></label>
          <label className="doc-form-wide">Файл<input name="file" type="file" accept={DOCUMENT_FILE_ACCEPT} required /></label>
          <label className="doc-form-full">Комментарий<textarea name="description" maxLength={4000} rows={2} /></label>
          <button className="primary" type="submit">Загрузить</button>
        </form><p className="form-help">{DOCUMENT_FILE_TYPES_LABEL}, до {MAX_DOCUMENT_FILE_SIZE_LABEL}. Документ будет доступен только вашей компании и сотрудникам ARSEO.</p>
      </section>}
    </section>
  </main>;
}
