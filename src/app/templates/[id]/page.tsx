import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import { DocumentActions } from "@/components/documents/document-actions";
import { loadDocumentActions } from "@/lib/documents/load-actions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { DOCUMENT_FILE_ACCEPT, DOCUMENT_FILE_TYPES_LABEL, MAX_DOCUMENT_FILE_SIZE_LABEL, formatFileSize } from "@/lib/documents/files.ts";
import { formatDateTime } from "@/lib/documents/labels.ts";
import {
  TEMPLATE_LANGUAGES,
  availableTemplateActions,
  schemaToVariables,
  templateDirectionLabel,
  templateLanguageLabel,
  templateStatusLabel,
  variablesToText,
} from "@/lib/templates/rules.ts";
import { loadTemplatePermissions } from "@/lib/templates/supabase-gateway.ts";
import {
  addTemplateVersionAction,
  approveTemplateAction,
  archiveTemplateAction,
  setTemplateActiveAction,
  updateTemplateAction,
} from "../actions";

type Named = { full_name: string } | { full_name: string }[] | null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);

type TemplateRecord = {
  id: string; document_type_id: string; name: string; language: string; flow_direction: string; purpose: string | null; counterparty_id: string | null;
  variables_schema: unknown; status: string; is_active: boolean; current_version: number; approved_at: string | null;
  created_at: string; updated_at: string; archived_at: string | null; archive_reason: string | null;
  type: { name_ru: string } | null; counterparty: { legal_name: string; short_name: string | null } | null;
  creator: Named; approver: Named; archiver: Named;
};

export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  if (!UUID.test(id)) notFound();
  const { profile, roles, supabase } = await requireUser();
  const [can, generationAccess] = await Promise.all([loadTemplatePermissions(supabase), loadPermissions(supabase, ["documents.create", "shipments.view"] as const)]);
  if (!can.view) notFound();

  const [{ data }, { data: versions }, { data: types }] = await Promise.all([
    supabase
      .from("document_templates")
      .select(
        "id, document_type_id, name, language, flow_direction, purpose, counterparty_id, variables_schema, status, is_active, current_version, approved_at, created_at, updated_at, archived_at, archive_reason, " +
          "type:document_types(name_ru), counterparty:counterparties(legal_name, short_name), " +
          "creator:profiles!document_templates_created_by_fkey(full_name), approver:profiles!document_templates_approved_by_fkey(full_name), archiver:profiles!document_templates_archived_by_fkey(full_name)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("document_template_versions")
      .select("id, version_number, original_filename, mime_type, file_size_bytes, comment, is_current, uploaded_at, uploader:profiles!document_template_versions_uploaded_by_fkey(full_name)")
      .eq("template_id", id)
      .order("version_number", { ascending: false }),
    supabase.from("document_types").select("id, name_ru, is_active").order("sort_order"),
  ]);
  if (!data) notFound();
  const template = data as unknown as TemplateRecord;
  const archived = template.status === "archived";
  const actions = availableTemplateActions(template, can);
  const variables = schemaToVariables(template.variables_schema);
  const currentVersion = (versions ?? []).find((version) => version.is_current);
  const canGenerate = can.generate && generationAccess["documents.create"] && generationAccess["shipments.view"] && template.status === "approved" && template.is_active && ["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(String(currentVersion?.mime_type));
  const { data: generations } = can.generate
    ? await supabase.from("document_generations").select("id, generated_at, contains_prices, shipment:shipments(id, shipment_number), document:documents(id, title)").eq("template_id", id).order("generated_at", { ascending: false }).limit(20)
    : { data: [] };
  const { data: counterparties } = actions.includes("edit")
    ? await supabase.from("counterparties").select("id, legal_name, short_name, roles").eq("status", "active").order("legal_name").limit(500)
    : { data: [] };
  const counterparty = one(template.counterparty);

  const documentActions = await loadDocumentActions(supabase, (generations ?? []).map(row => one(row.document)?.id));
  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="templates" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">{templateDirectionLabel[template.flow_direction]} · {one(template.type)?.name_ru ?? "тип не указан"}</p><h1>{template.name}</h1></div>
          <div className="topbar-actions">
            <span className={`doc-badge template-status-${template.status}`}>{templateStatusLabel[template.status] ?? template.status}</span>
            {!archived && <span className={`doc-badge ${template.is_active ? "doc-optional" : "doc-archive-badge"}`}>{template.is_active ? "Включён" : "Отключён"}</span>}
            {canGenerate && <Link className="primary button-link" href={`/templates/${template.id}/generate`}>Сформировать документ</Link>}
            <Link className="ghost button-link" href="/templates">К каталогу</Link>
          </div>
        </header>
    <WorkflowHelp section="templates"/>
        {notices.error && <div className="login-error admin-message">{notices.error}</div>}
        {notices.success && <div className="login-success admin-message">{notices.success}</div>}
        {archived && (
          <div className="setup-notice">
            Шаблон в архиве с {formatDateTime(template.archived_at)}{one(template.archiver) ? ` (${one(template.archiver)!.full_name})` : ""}. Причина: {template.archive_reason}. Файлы и версии сохранены.
          </div>
        )}
        {template.status === "draft" && !archived && (
          <div className="setup-notice">Шаблон — черновик: его текущая версия ещё не утверждена и не предлагается для карт ввода и вывода.</div>
        )}

        <section className="shipment-summary-grid">
          <article className="summary-card"><p>Направление</p><strong>{templateDirectionLabel[template.flow_direction]}</strong><small>{counterparty ? `для ${counterparty.short_name || counterparty.legal_name}` : "общий шаблон"}</small></article>
          <article className="summary-card"><p>Текущая версия</p><strong>{template.current_version}</strong><small>всего версий: {versions?.length ?? 0}</small></article>
          <article className="summary-card"><p>Утверждён</p><strong>{template.status === "approved" ? one(template.approver)?.full_name ?? "—" : "—"}</strong><small>{template.status === "approved" ? formatDateTime(template.approved_at) : "требуется утверждение"}</small></article>
          <article className="summary-card"><p>Создал</p><strong>{one(template.creator)?.full_name ?? "—"}</strong><small>{formatDateTime(template.created_at)}</small></article>
        </section>

        <section className="shipment-detail-grid">
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Файл</p><h2>Текущая версия</h2></div><span className="page-count">версия {template.current_version}</span></div>
            {currentVersion ? (
              <div className="doc-current-file">
                <div><strong>{currentVersion.original_filename}</strong><small>{formatFileSize(currentVersion.file_size_bytes)} · {currentVersion.mime_type}</small></div>
                {actions.includes("download") && <a className="primary button-link" href={`/templates/${template.id}/download?version=${currentVersion.id}`}>Скачать оригинал</a>}
              </div>
            ) : <div className="empty-state">Файл не найден.</div>}
            {!actions.includes("download") && <p className="form-help">Скачивание файла шаблона доступно с правом «Шаблоны: скачивание».</p>}
            {template.purpose && <p className="doc-description">{template.purpose}</p>}
            {actions.includes("upload") && (
              <form action={addTemplateVersionAction} className="doc-subform">
                <input type="hidden" name="template_id" value={template.id} />
                <label>Новая версия файла<input name="file" type="file" required accept={DOCUMENT_FILE_ACCEPT} /></label>
                <label>Что изменилось<input name="comment" maxLength={1000} placeholder="Например: добавлено поле GTIN" /></label>
                <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Загрузить версию</PendingSubmitButton>
                <p className="form-help">{DOCUMENT_FILE_TYPES_LABEL}, до {MAX_DOCUMENT_FILE_SIZE_LABEL}. Предыдущие версии сохраняются; после загрузки шаблон снова требует утверждения.</p>
              </form>
            )}
          </section>

          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Состав</p><h2>Поля для подстановки</h2></div><span className="page-count">{variables.length}</span></div>
            <div className="compact-list">
              {variables.map((variable) => (
                <div className="doc-link-row" key={variable.key}><div><span className="doc-type">{variable.key}</span><strong>{variable.label}</strong></div></div>
              ))}
              {!variables.length && <div className="empty-state">Поля для подстановки не описаны.</div>}
            </div>
            {(actions.includes("approve") || actions.includes("activate") || actions.includes("deactivate")) && (
              <div className="template-actions">
                {actions.includes("approve") && (
                  <form action={approveTemplateAction}>
                    <input type="hidden" name="template_id" value={template.id} />
                    <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Утвердить версию {template.current_version}</PendingSubmitButton>
                  </form>
                )}
                {(actions.includes("activate") || actions.includes("deactivate")) && (
                  <form action={setTemplateActiveAction}>
                    <input type="hidden" name="template_id" value={template.id} />
                    <input type="hidden" name="is_active" value={template.is_active ? "false" : "true"} />
                    <PendingSubmitButton pendingText="Выполняем…" className="ghost" type="submit">{template.is_active ? "Отключить" : "Включить"}</PendingSubmitButton>
                  </form>
                )}
              </div>
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
                  {actions.includes("download") && <a className="ghost button-link compact" href={`/templates/${template.id}/download?version=${version.id}`}>Скачать оригинал</a>}
                </div>
              </div>
            ))}
          </div>
        </section>

        {can.generate && <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">Автозаполнение</p><h2>Сформированные документы</h2></div><span className="page-count">{generations?.length ?? 0}</span></div>
          <div className="compact-list">{(generations ?? []).map((generation) => { const shipment = one(generation.shipment); const document = one(generation.document); return <div className="doc-link-row" key={generation.id}><div><strong>{document?.title ?? "Документ"}</strong><small>{shipment?.shipment_number ?? "Поставка"} · {formatDateTime(generation.generated_at)}{generation.contains_prices ? " · с ценами" : ""}</small></div>{document && <DocumentActions document={documentActions[document.id]}/>}</div>; })}{!generations?.length && <div className="empty-state">По этому шаблону документы ещё не формировались.</div>}</div>
        </section>}

        {actions.includes("edit") && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Реквизиты</p><h2>Изменить шаблон</h2></div></div>
            <form action={updateTemplateAction} className="doc-form">
              <input type="hidden" name="template_id" value={template.id} />
              <label>Тип документа<select name="document_type_id" required defaultValue={template.document_type_id}>
                {(types ?? []).filter((type) => type.is_active || type.id === template.document_type_id).map((type) => <option value={type.id} key={type.id}>{type.name_ru}</option>)}
              </select></label>
              <input type="hidden" name="flow_direction" value={template.flow_direction} />
              <label>Направление<input value={templateDirectionLabel[template.flow_direction]} readOnly /></label>
              <label className="doc-form-wide">Название<input name="name" required maxLength={200} defaultValue={template.name} /></label>
              <label>Язык<select name="language" defaultValue={template.language}>
                {TEMPLATE_LANGUAGES.map((code) => <option value={code} key={code}>{templateLanguageLabel[code]}</option>)}
              </select></label>
              <label className="doc-form-wide">Назначение<input name="purpose" maxLength={1000} defaultValue={template.purpose ?? ""} /></label>
              <label className="doc-form-wide">Контрагент<select name="counterparty_id" defaultValue={template.counterparty_id ?? ""}>
                <option value="">Общий шаблон</option>
                {(counterparties ?? []).filter((party) => template.flow_direction === "input" ? party.roles.some((role: string) => role === "manufacturer" || role === "supplier") : party.roles.includes("customer")).map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
              </select></label>
              <label className="doc-form-full">Поля для подстановки — по одному в строке, «ключ — описание»
                <textarea name="variables" rows={3} defaultValue={variablesToText(variables)} />
              </label>
              <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Сохранить</PendingSubmitButton>
              {template.status === "approved" && (
                <p className="form-help doc-form-full">Изменение типа, направления, языка, контрагента или полей вернёт шаблон в черновик — потребуется повторное утверждение.</p>
              )}
            </form>
          </section>
        )}

        {actions.includes("archive") && (
          <section className="panel admin-section doc-danger-zone">
            <div className="panel-heading"><div><p className="eyebrow">Архив</p><h2>Перенести шаблон в архив</h2></div></div>
            <p className="form-help">Шаблон не удаляется: файлы и история версий сохраняются. Архивный шаблон нельзя изменить или выбрать для новой карты.</p>
            <form action={archiveTemplateAction} className="doc-subform doc-archive-form">
              <input type="hidden" name="template_id" value={template.id} />
              <label>Причина<input name="reason" required minLength={3} maxLength={500} placeholder="Например: клиент прислал новую форму" /></label>
              <PendingSubmitButton pendingText="Выполняем…" className="ghost danger-text" type="submit">В архив</PendingSubmitButton>
            </form>
          </section>
        )}
      </section>
    </main>
  );
}
