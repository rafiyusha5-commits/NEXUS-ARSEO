import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import { DocumentActions } from "@/components/documents/document-actions";
import { loadDocumentActions } from "@/lib/documents/load-actions";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { DOCUMENT_FILE_ACCEPT, DOCUMENT_FILE_TYPES_LABEL, MAX_DOCUMENT_FILE_SIZE_LABEL } from "@/lib/documents/files.ts";
import { documentCategoryLabel, documentStatusLabel, formatDate, formatDateTime, languageLabel, linkEntityLabel } from "@/lib/documents/labels.ts";
import { loadLinkOptions, type LinkOptionGroup } from "@/lib/documents/link-objects.ts";
import {
  DOCUMENT_STATUSES,
  EXPIRING_SOON_DAYS,
  LINK_ENTITY_TYPES,
  documentExpiry,
  isUuid,
  parseLinkValue,
  sanitizeSearchTerm,
  todayIso,
} from "@/lib/documents/rules.ts";
import { loadDocumentPermissions } from "@/lib/documents/supabase-gateway.ts";
import { BulkDocumentUpload } from "@/components/documents/bulk-document-upload";
import { registerDocumentAction } from "./actions";

type SearchParams = {
  q?: string;
  type?: string;
  status?: string;
  entity?: string;
  object?: string;
  expiring?: string;
  archive?: string;
  link?: string;
  doc_type?: string;
  error?: string;
  success?: string;
};

type DocumentRow = {
  id: string;
  document_number: string | null;
  title: string;
  document_date: string | null;
  valid_until: string | null;
  status: string;
  archived_at: string | null;
  created_at: string;
  current_version: number;
  original_filename: string | null;
  type: { name_ru: string } | { name_ru: string }[] | null;
  uploader: { full_name: string } | { full_name: string }[] | null;
  links: { entity_type: string; removed_at: string | null }[];
};

type TypeRow = { id: string; code: string; name_ru: string; category: string; is_active: boolean };

const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function ExpiryBadge({ validUntil, today }: { validUntil: string | null; today: string }) {
  const expiry = documentExpiry(validUntil, today);
  if (expiry.state === "expired") return <span className="doc-badge doc-expired">Истёк</span>;
  if (expiry.state === "expiring") {
    return <span className="doc-badge doc-expiring">{expiry.daysLeft === 0 ? "Истекает сегодня" : `Истекает через ${expiry.daysLeft} дн.`}</span>;
  }
  return null;
}

function LinkSelect({ name, groups, defaultValue, placeholder }: { name: string; groups: LinkOptionGroup[]; defaultValue?: string; placeholder: string }) {
  return (
    <select name={name} defaultValue={defaultValue ?? ""}>
      <option value="">{placeholder}</option>
      {groups.map((group) => (
        <optgroup label={group.label} key={group.entityType}>
          {group.options.map((option) => (
            <option value={option.value} key={option.value}>{option.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requirePageUser();
  const permissions = await loadDocumentPermissions(supabase);
  const today = todayIso();

  const { data: typeRows, error: typesError } = await supabase
    .from("document_types")
    .select("id, code, name_ru, category, is_active")
    .order("sort_order");
  const types = (typeRows ?? []) as TypeRow[];
  const migrationMissing = Boolean(typesError);

  const search = sanitizeSearchTerm(params.q);
  const typeFilter = isUuid(params.type) ? params.type : "";
  const statusFilter = (DOCUMENT_STATUSES as readonly string[]).includes(params.status ?? "") ? params.status! : "";
  const entityFilter = (LINK_ENTITY_TYPES as readonly string[]).includes(params.entity ?? "") ? params.entity! : "";
  const objectFilter = parseLinkValue(params.object ?? "");
  const archiveMode = params.archive === "only" ? "only" : params.archive === "all" ? "all" : "active";
  const expiringOnly = params.expiring === "1";

  let documents: DocumentRow[] = [];
  let listError: string | null = null;
  let linkOptions: LinkOptionGroup[] = [];
  let summary = { active: 0, expiring: 0, expired: 0 };

  if (!migrationMissing && permissions.view) {
    let documentIds: string[] | null = null;
    if (objectFilter || entityFilter) {
      let linkQuery = supabase.from("document_links").select("document_id").is("removed_at", null).limit(2000);
      linkQuery = objectFilter
        ? linkQuery.eq("entity_type", objectFilter.entity_type).eq("entity_id", objectFilter.entity_id)
        : linkQuery.eq("entity_type", entityFilter);
      const { data } = await linkQuery;
      documentIds = [...new Set((data ?? []).map((row) => row.document_id as string))];
    }

    if (documentIds === null || documentIds.length > 0) {
      let query = supabase
        .from("documents")
        .select(
          "id, document_number, title, document_date, valid_until, status, archived_at, created_at, current_version, original_filename, " +
            "type:document_types(name_ru), uploader:profiles!documents_uploaded_by_fkey(full_name), links:document_links(entity_type, removed_at)",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (documentIds) query = query.in("id", documentIds);
      if (typeFilter) query = query.eq("document_type_id", typeFilter);
      if (statusFilter) query = query.eq("status", statusFilter);
      if (archiveMode === "active") query = query.is("archived_at", null);
      if (archiveMode === "only") query = query.not("archived_at", "is", null);
      if (expiringOnly) query = query.not("valid_until", "is", null).lte("valid_until", addDays(today, EXPIRING_SOON_DAYS));
      if (search) {
        const pattern = `*${search}*`;
        query = query.or(`title.ilike.${pattern},document_number.ilike.${pattern},original_filename.ilike.${pattern}`);
      }
      const { data, error } = await query;
      documents = (data ?? []) as unknown as DocumentRow[];
      listError = error?.message ?? null;
    }

    const soon = addDays(today, EXPIRING_SOON_DAYS);
    const [active, expiring, expired] = await Promise.all([
      supabase.from("documents").select("id", { count: "exact", head: true }).is("archived_at", null),
      supabase.from("documents").select("id", { count: "exact", head: true }).is("archived_at", null).gte("valid_until", today).lte("valid_until", soon),
      supabase.from("documents").select("id", { count: "exact", head: true }).is("archived_at", null).lt("valid_until", today),
    ]);
    summary = { active: active.count ?? 0, expiring: expiring.count ?? 0, expired: expired.count ?? 0 };
  }

  if (!migrationMissing && (permissions.view || permissions.create)) {
    linkOptions = await loadLinkOptions(supabase);
  }

  const { data: currencies } = permissions.create && !migrationMissing
    ? await supabase.from("currencies").select("id, code").eq("is_active", true).order("code")
    : { data: [] };

  const documentActions = await loadDocumentActions(supabase, documents.map(doc => doc.id));
  const prefillLink = parseLinkValue(params.link ?? "");
  const prefillType = isUuid(params.doc_type) ? params.doc_type : undefined;
  const returnTo = prefillLink?.entity_type === "shipment" ? `/shipments/${prefillLink.entity_id}` : "/documents";
  const activeTypes = types.filter((type) => type.is_active);
  const categories = [...new Set(activeTypes.map((type) => type.category))];
  const hasFilters = Boolean(search || typeFilter || statusFilter || entityFilter || objectFilter || expiringOnly || archiveMode !== "active");

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="documents" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Документооборот</p><h1>Документы</h1></div>
          <div className="topbar-actions">
            {permissions.create && !migrationMissing && <a className="primary button-link" href="#register">+ Зарегистрировать документ</a>}
            {permissions.view && <span className="page-count">{documents.length} в выборке</span>}
          </div>
        </header>
    <WorkflowHelp section="documents"/>

        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}

        {migrationMissing && (
          <div className="setup-notice">
            Модуль документов ещё не подключён к базе. Администратору: примените миграцию{" "}
            <strong>202609271001_document_management.sql</strong> (инструкция — docs/documents-module.md).
          </div>
        )}

        {!migrationMissing && !permissions.view && !permissions.create && (
          <section className="panel admin-section">
            <div className="empty-state">
              У вас нет доступа к документам. Обратитесь к администратору Nexus-ARSEO, чтобы получить право «Документы: просмотр».
            </div>
          </section>
        )}

        {!migrationMissing && permissions.view && (
          <>
            <section className="shipment-summary-grid">
              <article className="summary-card"><p>Действующие документы</p><strong>{summary.active}</strong><small>без архивных</small></article>
              <Link className="summary-card doc-summary-link" href="/documents?expiring=1">
                <p>Истекают в ближайшие {EXPIRING_SOON_DAYS} дней</p><strong>{summary.expiring}</strong><small>открыть список</small>
              </Link>
              <article className="summary-card"><p>Срок действия истёк</p><strong className={summary.expired ? "doc-alert-number" : undefined}>{summary.expired}</strong><small>требуют замены</small></article>
              <article className="summary-card"><p>Типов документов</p><strong>{activeTypes.length}</strong><small>в справочнике</small></article>
            </section>

            <section className="panel admin-section">
              <div className="panel-heading"><div><p className="eyebrow">Реестр</p><h2>Поиск и фильтры</h2></div>
                {hasFilters && <Link className="text-button" href="/documents">Сбросить фильтры</Link>}
              </div>
              <form className="doc-filters" method="get">
                <label className="doc-filter-search">Поиск<input name="q" defaultValue={search} placeholder="Название, номер или имя файла" /></label>
                <label>Тип<select name="type" defaultValue={typeFilter}>
                  <option value="">Все типы</option>
                  {types.map((type) => <option value={type.id} key={type.id}>{type.name_ru}{type.is_active ? "" : " (отключён)"}</option>)}
                </select></label>
                <label>Статус<select name="status" defaultValue={statusFilter}>
                  <option value="">Все статусы</option>
                  {DOCUMENT_STATUSES.map((status) => <option value={status} key={status}>{documentStatusLabel[status]}</option>)}
                </select></label>
                <label>Связан с<select name="entity" defaultValue={entityFilter}>
                  <option value="">Любым объектом</option>
                  {LINK_ENTITY_TYPES.filter((type) => type !== "customer_return").map((type) => <option value={type} key={type}>{linkEntityLabel[type]}</option>)}
                </select></label>
                <label className="doc-filter-object">Конкретный объект<LinkSelect name="object" groups={linkOptions} defaultValue={params.object ?? ""} placeholder="Не выбран" /></label>
                <label>Архив<select name="archive" defaultValue={archiveMode}>
                  <option value="active">Без архивных</option>
                  <option value="all">Все документы</option>
                  <option value="only">Только архив</option>
                </select></label>
                <label className="check-label"><input type="checkbox" name="expiring" value="1" defaultChecked={expiringOnly} /> Срок истекает или истёк</label>
                <button className="primary" type="submit">Показать</button>
              </form>

              {listError && <div className="login-error admin-message">Не удалось загрузить реестр документов.</div>}

              <div className="doc-list">
                {documents.map((document) => {
                  const type = one(document.type);
                  const uploader = one(document.uploader);
                  const activeLinks = document.links.filter((link) => !link.removed_at);
                  const linkTypes = [...new Set(activeLinks.map((link) => link.entity_type))];
                  return (
                    <article className={`doc-row${document.archived_at ? " doc-archived" : ""}`} key={document.id}>
                      <div className="doc-main">
                        <span className="doc-type">{type?.name_ru ?? "Тип не указан"}</span>
                        <strong><Link href={`/documents/${document.id}`}>{document.title}</Link></strong>
                        <small>{document.document_number ? `№ ${document.document_number}` : "Без номера"} · версия {document.current_version} · {document.original_filename ?? "файл"}</small>
                      </div>
                      <div className="doc-dates">
                        <strong>{formatDate(document.document_date)}</strong>
                        <small>дата документа</small>
                      </div>
                      <div className="doc-dates">
                        <strong>{document.valid_until ? `до ${formatDate(document.valid_until)}` : "Бессрочно"}</strong>
                        <ExpiryBadge validUntil={document.archived_at ? null : document.valid_until} today={today} />
                      </div>
                      <div className="doc-links">
                        {linkTypes.length ? linkTypes.map((linkType) => <span className="reference-tag" key={linkType}>{linkEntityLabel[linkType] ?? linkType}</span>) : <span className="reference-tag">Без связей</span>}
                      </div>
                      <div className="doc-meta">
                        {document.archived_at
                          ? <span className="doc-badge doc-archive-badge">В архиве</span>
                          : <span className={`doc-badge doc-status-${document.status}`}>{documentStatusLabel[document.status] ?? document.status}</span>}
                        <small>{uploader?.full_name ?? "—"} · {formatDateTime(document.created_at)}</small>
                      </div>
                      <DocumentActions document={documentActions[document.id]}/>
                    </article>
                  );
                })}
                {!documents.length && !listError && (
                  <div className="empty-state">
                    {hasFilters ? "По заданным условиям документов нет. Измените фильтры или сбросьте их." : "Документы ещё не зарегистрированы. Загрузите первый документ с помощью формы ниже."}
                  </div>
                )}
                {documents.length === 200 && <p className="form-help">Показаны последние 200 документов. Уточните фильтры, чтобы найти остальные.</p>}
              </div>
            </section>
          </>
        )}

        {!migrationMissing && permissions.create && (
          <section className="panel admin-section" id="register">
            <div className="panel-heading"><div><p className="eyebrow">Пакетная загрузка</p><h2>Загрузить несколько документов</h2></div><a className="ghost button-link compact" href="#register-one">Подробная регистрация одного файла</a></div>
            <BulkDocumentUpload
              types={activeTypes.map(type => ({ id: type.id, code: type.code, name: type.name_ru, category: type.category }))}
              primaryLink={prefillLink ? `${prefillLink.entity_type}:${prefillLink.entity_id}` : undefined}
            />
          </section>
        )}

        {!migrationMissing && permissions.create && (
          <section className="panel admin-section" id="register-one">
            <div className="panel-heading"><div><p className="eyebrow">Один документ</p><h2>Регистрация с полными реквизитами</h2></div></div>
            {!activeTypes.length ? (
              <div className="empty-state">В справочнике нет активных типов документов. Обратитесь к администратору.</div>
            ) : (
              <form action={registerDocumentAction} className="doc-form">
                <input type="hidden" name="return_to" value={returnTo} />
                <label>Тип документа<select name="document_type_id" required defaultValue={prefillType ?? ""}>
                  <option value="" disabled>Выберите тип</option>
                  {categories.map((category) => (
                    <optgroup label={documentCategoryLabel[category] ?? category} key={category}>
                      {activeTypes.filter((type) => type.category === category).map((type) => <option value={type.id} key={type.id}>{type.name_ru}</option>)}
                    </optgroup>
                  ))}
                </select></label>
                <label className="doc-form-wide">Название<input name="title" required maxLength={300} placeholder="Например: Инвойс поставщика по заказу Leib7-x" /></label>
                <label>Номер<input name="document_number" maxLength={120} /></label>
                <label>Дата документа<input name="document_date" type="date" /></label>
                <label>Срок действия<input name="valid_until" type="date" /></label>
                <label>Сумма<input name="amount" inputMode="decimal" placeholder="0,00" /></label>
                <label>Валюта<select name="currency_id" defaultValue="">
                  <option value="">—</option>
                  {(currencies ?? []).map((currency) => <option value={currency.id} key={currency.id}>{currency.code}</option>)}
                </select></label>
                <label className="doc-form-wide">Основной связанный объект<LinkSelect name="link_primary" groups={linkOptions} defaultValue={prefillLink ? `${prefillLink.entity_type}:${prefillLink.entity_id}` : ""} placeholder="Не выбран" /></label>
                <label>Также связать с<LinkSelect name="link_extra_1" groups={linkOptions} placeholder="Не выбран" /></label>
                <label>Также связать с<LinkSelect name="link_extra_2" groups={linkOptions} placeholder="Не выбран" /></label>
                <label>Язык<select name="language" defaultValue="">
                  <option value="">Не указан</option>
                  {Object.entries(languageLabel).map(([code, label]) => <option value={code} key={code}>{label}</option>)}
                </select></label>
                <label className="doc-form-rest">Описание<textarea name="description" maxLength={4000} rows={2} /></label>
                <label className="doc-form-wide doc-file">Файл<input name="file" type="file" required accept={DOCUMENT_FILE_ACCEPT} /></label>
                <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Зарегистрировать</PendingSubmitButton>
                <p className="form-help doc-form-full">
                  Разрешены {DOCUMENT_FILE_TYPES_LABEL}, не больше {MAX_DOCUMENT_FILE_SIZE_LABEL}. Файл хранится в закрытом хранилище и скачивается по временной ссылке.
                  Повторная загрузка того же файла блокируется — откройте существующий документ и добавьте связь.
                </p>
              </form>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
