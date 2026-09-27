import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { DOCUMENT_FILE_ACCEPT, DOCUMENT_FILE_TYPES_LABEL, MAX_DOCUMENT_FILE_SIZE_LABEL, formatFileSize } from "@/lib/documents/files.ts";
import { documentStatusLabel, formatDate, formatDateTime, languageLabel, linkEntityLabel, linkRoleLabel } from "@/lib/documents/labels.ts";
import { loadLinkOptions, resolveLinkTargets } from "@/lib/documents/link-objects.ts";
import { DOCUMENT_STATUSES, documentExpiry, isUuid, todayIso } from "@/lib/documents/rules.ts";
import { loadDocumentPermissions } from "@/lib/documents/supabase-gateway.ts";
import {
  addDocumentLinkAction,
  addDocumentVersionAction,
  archiveDocumentAction,
  removeDocumentLinkAction,
  updateDocumentAction,
} from "../actions";

type Named = { full_name: string } | { full_name: string }[] | null;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  if (!isUuid(id)) notFound();

  const { profile, roles, supabase } = await requireUser();
  const permissions = await loadDocumentPermissions(supabase);
  if (!permissions.view) notFound();

  const [{ data: document }, { data: versions }, { data: links }, { data: types }, { data: currencies }] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, document_type_id, document_number, title, description, document_date, valid_until, status, language, amount, " +
          "current_version, original_filename, mime_type, file_size_bytes, created_at, updated_at, archived_at, archive_reason, " +
          "type:document_types(name_ru, name_en, name_kk, category, has_validity_period), currency:currencies(id, code), " +
          "uploader:profiles!documents_uploaded_by_fkey(full_name), archiver:profiles!documents_archived_by_fkey(full_name)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("document_versions")
      .select("id, version_number, original_filename, mime_type, file_size_bytes, comment, is_current, uploaded_at, uploader:profiles!document_versions_uploaded_by_fkey(full_name)")
      .eq("document_id", id)
      .order("version_number", { ascending: false }),
    supabase
      .from("document_links")
      .select("id, entity_type, entity_id, link_role, created_at, creator:profiles!document_links_created_by_fkey(full_name)")
      .eq("document_id", id)
      .is("removed_at", null)
      .order("created_at"),
    supabase.from("document_types").select("id, name_ru, is_active").order("sort_order"),
    supabase.from("currencies").select("id, code").eq("is_active", true).order("code"),
  ]);

  if (!document) notFound();
  const doc = document as unknown as {
    id: string; document_type_id: string; document_number: string | null; title: string; description: string | null;
    document_date: string | null; valid_until: string | null; status: string; language: string | null; amount: number | null;
    current_version: number; original_filename: string | null; mime_type: string | null; file_size_bytes: number | null;
    created_at: string; updated_at: string; archived_at: string | null; archive_reason: string | null;
    type: { name_ru: string; name_en: string | null; name_kk: string | null; has_validity_period: boolean } | null;
    currency: { id: string; code: string } | null; uploader: Named; archiver: Named;
  };
  const type = one(doc.type);
  const currency = one(doc.currency);
  const uploader = one(doc.uploader);
  const archiver = one(doc.archiver);
  const archived = doc.archived_at !== null;
  const canEdit = permissions.update && !archived;
  const today = todayIso();
  const expiry = documentExpiry(archived ? null : doc.valid_until, today);
  const activeLinks = (links ?? []) as { id: string; entity_type: string; entity_id: string; link_role: string; created_at: string; creator: Named }[];
  const targets = await resolveLinkTargets(supabase, activeLinks);
  const linkOptions = canEdit ? await loadLinkOptions(supabase) : [];
  const currentVersion = (versions ?? []).find((version) => version.is_current);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="documents" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{type?.name_ru ?? "Документ"}{doc.document_number ? ` · № ${doc.document_number}` : ""}</p>
            <h1>{doc.title}</h1>
          </div>
          <div className="topbar-actions">
            {archived
              ? <span className="doc-badge doc-archive-badge">В архиве</span>
              : <span className={`doc-badge doc-status-${doc.status}`}>{documentStatusLabel[doc.status] ?? doc.status}</span>}
            <Link className="ghost button-link" href="/documents">К реестру</Link>
          </div>
        </header>

        {notices.error && <div className="login-error admin-message">{notices.error}</div>}
        {notices.success && <div className="login-success admin-message">{notices.success}</div>}
        {archived && (
          <div className="setup-notice">
            Документ перенесён в архив {formatDateTime(doc.archived_at)}{archiver ? ` (${archiver.full_name})` : ""}. Причина: {doc.archive_reason}.
            Файлы и история версий сохранены, изменения запрещены.
          </div>
        )}
        {expiry.state === "expired" && <div className="login-error admin-message">Срок действия документа истёк {formatDate(doc.valid_until)}.</div>}
        {expiry.state === "expiring" && <div className="setup-notice">Срок действия истекает {formatDate(doc.valid_until)} — осталось {expiry.daysLeft} дн.</div>}

        <section className="shipment-summary-grid">
          <article className="summary-card"><p>Дата документа</p><strong>{formatDate(doc.document_date)}</strong><small>{languageLabel[doc.language ?? ""] ?? "Язык не указан"}</small></article>
          <article className="summary-card"><p>Срок действия</p><strong>{doc.valid_until ? formatDate(doc.valid_until) : "Бессрочно"}</strong><small>{type?.has_validity_period ? "для этого типа обычно указывается" : "не обязателен для типа"}</small></article>
          <article className="summary-card"><p>Сумма</p><strong>{doc.amount !== null ? `${Number(doc.amount).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ${currency?.code ?? ""}` : "—"}</strong><small>по документу</small></article>
          <article className="summary-card"><p>Зарегистрировал</p><strong>{uploader?.full_name ?? "—"}</strong><small>{formatDateTime(doc.created_at)}</small></article>
        </section>

        <section className="shipment-detail-grid">
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Файл</p><h2>Текущая версия</h2></div><span className="page-count">версия {doc.current_version}</span></div>
            {currentVersion ? (
              <div className="doc-current-file">
                <div><strong>{doc.original_filename}</strong><small>{formatFileSize(doc.file_size_bytes)} · {doc.mime_type}</small></div>
                <a className="primary button-link" href={`/documents/${doc.id}/download?version=${currentVersion.id}`}>Скачать</a>
              </div>
            ) : <div className="empty-state">Файл не найден.</div>}
            {doc.description && <p className="doc-description">{doc.description}</p>}

            {canEdit && (
              <form action={addDocumentVersionAction} className="doc-subform">
                <input type="hidden" name="document_id" value={doc.id} />
                <label>Новая версия файла<input name="file" type="file" required accept={DOCUMENT_FILE_ACCEPT} /></label>
                <label>Что изменилось<input name="comment" maxLength={1000} placeholder="Например: исправлена сумма" /></label>
                <button className="primary" type="submit">Загрузить версию</button>
                <p className="form-help">{DOCUMENT_FILE_TYPES_LABEL}, до {MAX_DOCUMENT_FILE_SIZE_LABEL}. Предыдущие версии сохраняются.</p>
              </form>
            )}
          </section>

          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Связи</p><h2>Связанные объекты</h2></div><span className="page-count">{activeLinks.length}</span></div>
            <div className="compact-list">
              {activeLinks.map((link) => {
                const target = targets.get(`${link.entity_type}:${link.entity_id}`);
                return (
                  <div className="doc-link-row" key={link.id}>
                    <div>
                      <span className="doc-type">{linkEntityLabel[link.entity_type] ?? link.entity_type} · {linkRoleLabel[link.link_role] ?? link.link_role}</span>
                      {target?.href ? <Link href={target.href}><strong>{target.label}</strong></Link> : <strong>{target?.label ?? "—"}</strong>}
                      <small>Связь добавил {one(link.creator)?.full_name ?? "—"} · {formatDateTime(link.created_at)}</small>
                    </div>
                    {canEdit && (
                      <form action={removeDocumentLinkAction}>
                        <input type="hidden" name="document_id" value={doc.id} />
                        <input type="hidden" name="link_id" value={link.id} />
                        <button className="ghost compact" type="submit">Снять связь</button>
                      </form>
                    )}
                  </div>
                );
              })}
              {!activeLinks.length && <div className="empty-state">Документ не связан ни с одним объектом.</div>}
            </div>
            {canEdit && linkOptions.length > 0 && (
              <form action={addDocumentLinkAction} className="doc-subform">
                <input type="hidden" name="document_id" value={doc.id} />
                <label>Объект<select name="link" required defaultValue="">
                  <option value="" disabled>Выберите объект</option>
                  {linkOptions.map((group) => (
                    <optgroup label={group.label} key={group.entityType}>
                      {group.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </optgroup>
                  ))}
                </select></label>
                <label>Назначение<select name="link_role" defaultValue="related">
                  {Object.entries(linkRoleLabel).map(([code, label]) => <option value={code} key={code}>{label}</option>)}
                </select></label>
                <button className="primary" type="submit">Добавить связь</button>
              </form>
            )}
          </section>
        </section>

        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">История</p><h2>Версии файла</h2></div><span className="page-count">{versions?.length ?? 0}</span></div>
          <div className="doc-version-list">
            {(versions ?? []).map((version) => (
              <div className={`doc-version-row${version.is_current ? " is-current" : ""}`} key={version.id}>
                <span className="stage-number">v{version.version_number}</span>
                <div><strong>{version.original_filename}</strong><small>{formatFileSize(version.file_size_bytes)} · {version.comment || "Без комментария"}</small></div>
                <div><strong>{one(version.uploader as Named)?.full_name ?? "—"}</strong><small>{formatDateTime(version.uploaded_at)}</small></div>
                <div className="doc-version-actions">
                  {version.is_current && <span className="doc-badge doc-status-approved">Актуальная</span>}
                  <a className="ghost button-link compact" href={`/documents/${doc.id}/download?version=${version.id}`}>Скачать</a>
                </div>
              </div>
            ))}
          </div>
        </section>

        {canEdit && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Реквизиты</p><h2>Изменить данные документа</h2></div></div>
            <form action={updateDocumentAction} className="doc-form">
              <input type="hidden" name="document_id" value={doc.id} />
              <label>Тип документа<select name="document_type_id" defaultValue={doc.document_type_id} required>
                {(types ?? []).filter((item) => item.is_active || item.id === doc.document_type_id).map((item) => <option value={item.id} key={item.id}>{item.name_ru}</option>)}
              </select></label>
              <label className="doc-form-wide">Название<input name="title" required maxLength={300} defaultValue={doc.title} /></label>
              <label>Номер<input name="document_number" maxLength={120} defaultValue={doc.document_number ?? ""} /></label>
              <label>Статус<select name="status" defaultValue={doc.status}>
                {DOCUMENT_STATUSES.map((status) => <option value={status} key={status}>{documentStatusLabel[status]}</option>)}
              </select></label>
              <label>Дата документа<input name="document_date" type="date" defaultValue={doc.document_date ?? ""} /></label>
              <label>Срок действия<input name="valid_until" type="date" defaultValue={doc.valid_until ?? ""} /></label>
              <label>Язык<select name="language" defaultValue={doc.language ?? ""}>
                <option value="">Не указан</option>
                {Object.entries(languageLabel).map(([code, label]) => <option value={code} key={code}>{label}</option>)}
              </select></label>
              <label>Сумма<input name="amount" inputMode="decimal" defaultValue={doc.amount ?? ""} /></label>
              <label>Валюта<select name="currency_id" defaultValue={currency?.id ?? ""}>
                <option value="">—</option>
                {(currencies ?? []).map((item) => <option value={item.id} key={item.id}>{item.code}</option>)}
              </select></label>
              <label className="doc-form-full">Описание<textarea name="description" maxLength={4000} rows={2} defaultValue={doc.description ?? ""} /></label>
              <button className="primary" type="submit">Сохранить</button>
            </form>
          </section>
        )}

        {permissions.archive && !archived && (
          <section className="panel admin-section doc-danger-zone">
            <div className="panel-heading"><div><p className="eyebrow">Архив</p><h2>Перенести документ в архив</h2></div></div>
            <p className="form-help">Документ не удаляется: файлы, версии, связи и история остаются доступны для просмотра. Изменять архивный документ нельзя.</p>
            <form action={archiveDocumentAction} className="doc-subform doc-archive-form">
              <input type="hidden" name="document_id" value={doc.id} />
              <label>Причина<input name="reason" required minLength={3} maxLength={500} placeholder="Например: заменён новым документом" /></label>
              <button className="ghost danger-text" type="submit">В архив</button>
            </form>
          </section>
        )}
      </section>
    </main>
  );
}
