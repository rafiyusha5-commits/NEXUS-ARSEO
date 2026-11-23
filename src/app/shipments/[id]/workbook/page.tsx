import Link from "next/link";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireUser } from "@/lib/auth/access";
import { isUuid } from "@/lib/documents/rules";
import { loadPermissions } from "@/lib/permissions";
import { selectAll } from "@/lib/supabase/select-all";
import { businessToday } from "@/lib/dates/business-day";
import { shipmentDrive } from "@/lib/google/drive-server";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { readFirstSheet, readOrderWorkbookSheets } from "@/lib/google/order-workbook-sheet";
import { customsIssues, isDistributionSheet, matchCustomer, overDistributed, parseCustomsSheet, parseDistributionSheet, parseStickerSheet } from "@/lib/shipments/order-workbook-extra";
import { CustomsCheck, DistributionView, StickerCheck, type SaleTarget, type StickerRow } from "./phase2";
import { PublicError } from "@/lib/errors/public-message";
import { isOrderWorkbook, matchLine, orderWorkbooks, parseOrderWorkbook, planLines, type LinePlan, type OrderWorkbook, type ProductKeys } from "@/lib/shipments/order-workbook";
import { applyOrderWorkbook } from "./actions";

const REQUIRED = ["shipments.view", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;
const OPTIONAL = ["sales.view", "sales.manage", "stickers.view"] as const;
const SHEET = "application/vnd.google-apps.spreadsheet";
type Params = { file?: string; distribution?: string; error?: string; success?: string };
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(new Date(value)) : "—";
const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value);
const kindLabel: Record<LinePlan["kind"], string> = { add: "Новая позиция", update: "Изменится", same: "Совпадает", split: "Распределена по машинам — не меняется", unknown: "Не сопоставлена" };

export default async function OrderWorkbookPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const { id } = await params; const query = await searchParams;
  if (!isUuid(id)) redirect("/shipments");
  const { profile, roles, supabase } = await requireUser();
  const shell = (body: React.ReactNode, title = "Данные из «Вн расчетов»") => <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Поставка · Google Таблицы только чтение</p><h1>{title}</h1></div><div className="topbar-actions"><Link className="ghost button-link" href={`/shipments/${id}?tab=documents#drive-folder`}>К поставке</Link></div></header>
    {query.error && <div className="login-error admin-message">{query.error}</div>}{query.success && <div className="login-success admin-message">{query.success}</div>}
    {body}</section></main>;
  const permissions = await loadPermissions(supabase, [...REQUIRED, ...OPTIONAL]);
  if (REQUIRED.some(code => !permissions[code])) return shell(<div className="setup-notice">Нужны права на изменение поставки, документы Google Drive и закупочные цены.</div>);
  const { data: shipment } = await supabase.from("shipments").select("id,shipment_number,project_code,supplier_id,planned_ready_date,planned_arrival_date,is_locked,status,currency_id").eq("id", id).maybeSingle();
  if (!shipment) return shell(<div className="setup-notice">Поставка недоступна.</div>);
  const title = `«Вн расчеты» · ${shipment.shipment_number}`;

  let workbooks: { file_id: string; name: string }[] = []; let distributions: { file_id: string; name: string }[] = []; let folderId = "";
  try {
    const db = await shipmentDriveGateway(supabase);
    const [binding, files] = await Promise.all([
      db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", id).maybeSingle(),
      db.from("shipment_drive_files").select("file_id,name,mime_type,present").eq("shipment_id", id).eq("present", true).limit(1000),
    ]);
    if (binding.error || files.error) throw new Error("unavailable");
    folderId = binding.data?.folder_id ?? "";
    workbooks = orderWorkbooks((files.data ?? []).filter(file => isOrderWorkbook(file.name, file.mime_type)), shipment.project_code);
    distributions = (files.data ?? []).filter(file => isDistributionSheet(file.name, file.mime_type)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  } catch { return shell(<div className="setup-notice">Привязка Google Drive сейчас недоступна.</div>, title); }
  if (!folderId) return shell(<div className="setup-notice">К поставке не привязана папка Google Drive.</div>, title);
  if (!workbooks.length) return shell(<div className="setup-notice">В сохранённом списке папки нет таблицы «Вн расчеты». Нажмите «Обновить из Drive» на вкладке «Документы» и откройте эту страницу снова.</div>, title);
  const chosen = workbooks.find(file => file.file_id === query.file) ?? (workbooks.length === 1 ? workbooks[0] : null);
  if (!chosen) return shell(<section className="panel admin-section"><h2>Выберите таблицу «Вн расчеты»</h2><p className="form-help">В папке несколько подходящих таблиц{shipment.project_code ? ` с кодом ${shipment.project_code}` : ""}. Откройте ту, по которой работаете.</p><ul>{workbooks.map(file => <li key={file.file_id}><Link href={`/shipments/${id}/workbook?file=${encodeURIComponent(file.file_id)}`}>{file.name}</Link></li>)}</ul></section>, title);

  // The sheet must still lie inside the bound folder before anything is read from it.
  let workbook: OrderWorkbook;
  let sheets: Awaited<ReturnType<typeof readOrderWorkbookSheets>>;
  try {
    const reference = await shipmentDrive().scopedReference(chosen.file_id, AbortSignal.timeout(30000));
    if (reference.mimeType !== SHEET || !reference.ancestors?.includes(folderId)) throw new PublicError("Таблица больше не лежит в папке поставки. Обновите папку из Drive.");
    sheets = await readOrderWorkbookSheets(chosen.file_id);
    workbook = parseOrderWorkbook(sheets.calculation, sheets.client);
  } catch (error) {
    const message = error instanceof PublicError || (error instanceof Error && /^В листе/.test(error.message)) ? error.message : "Не удалось прочитать таблицу. Проверьте доступ к папке и повторите.";
    return shell(<div className="login-error admin-message">{message}</div>, title);
  }

  const [products, identifiers, items, prices, currencies] = await Promise.all([
    selectAll((from, to) => supabase.from("products").select("id,internal_sku,name,hs_code,country_of_origin,requires_sticker").order("id").range(from, to)),
    selectAll((from, to) => supabase.from("product_identifiers").select("product_id,identifier_type,value,counterparty_id").order("id").range(from, to)),
    supabase.from("shipment_items").select("id,product_id,ordered_quantity,currency_id,shipment_transport_id").eq("shipment_id", id),
    supabase.rpc("my_shipment_item_purchase_prices", { p_shipment_id: id }),
    supabase.from("currencies").select("id,code"),
  ]);
  if (products.error || identifiers.error || items.error || prices.error) return shell(<div className="setup-notice">Не удалось загрузить товары поставки. Обновите страницу.</div>, title);
  const keys: ProductKeys[] = (products.data ?? []).map(product => ({ id: product.id, sku: product.internal_sku,
    supplierSkus: (identifiers.data ?? []).filter(row => row.product_id === product.id && row.identifier_type === "supplier_sku" && (!shipment.supplier_id || row.counterparty_id === shipment.supplier_id)).map(row => row.value),
    eans: (identifiers.data ?? []).filter(row => row.product_id === product.id && (row.identifier_type === "gtin" || row.identifier_type === "unit_barcode")).map(row => row.value.replace(/\D/g, "")) }));
  const priceOf = new Map(((prices.data ?? []) as { item_id: string; unit_price: number | string | null }[]).map(row => [row.item_id, row.unit_price === null ? null : Number(row.unit_price)]));
  const eur = currencies.data?.find(currency => currency.code === "EUR")?.id;
  const existing = (items.data ?? []).map(item => ({ id: item.id, product_id: item.product_id, quantity: Number(item.ordered_quantity), price: priceOf.get(item.id) ?? null, transport: item.shipment_transport_id, currency: item.currency_id }));
  const { plans, notInWorkbook } = planLines(workbook.lines, keys, existing);
  const productName = (productId: string) => { const product = products.data?.find(row => row.id === productId); if (!product) return "—"; const name = product.name as Record<string, string> | null; return `${product.internal_sku} · ${name?.ru ?? name?.en ?? ""}`; };
  const locked = shipment.is_locked || shipment.status === "closed" || shipment.status === "cancelled";
  const changes = plans.filter(plan => plan.kind === "add" || plan.kind === "update");
  const readyChanges = workbook.loadingDate && workbook.loadingDate !== shipment.planned_ready_date;

  // ── Phase 2: customs and sticker checks, distribution and client order drafts ──
  const keyOf = (sku: string, factorySku: string, ean: string) => { const match = matchLine({ row: 0, sku, factorySku, ean, name: "", quantity: 1, price: null }, keys); return "id" in match ? match.id : null; };
  const productRow = (productId: string | null) => products.data?.find(row => row.id === productId) ?? null;
  const itemTotals = (productId: string) => { const rows = existing.filter(item => item.product_id === productId); if (!rows.length) return null;
    return { quantity: rows.reduce((sum, item) => sum + item.quantity, 0), price: rows.length === 1 ? rows[0].price : rows.every(item => item.price === rows[0].price) ? rows[0].price : null }; };
  const customsLines = parseCustomsSheet(sheets.customs);
  const issues = customsIssues(customsLines, line => { const product = productRow(keyOf(line.article, line.article, line.ean)); return product ? { id: product.id, hs_code: product.hs_code, country_of_origin: product.country_of_origin } : null; }, itemTotals);
  const stickerSheet = parseStickerSheet(sheets.stickers);
  const templates = permissions["stickers.view"] ? await supabase.from("sticker_templates").select("product_id,customer_id,sticker_level,current_version:sticker_template_versions!sticker_templates_current_version_fk(status)").eq("status", "active") : { data: null };
  const approved = (productId: string, level: "unit" | "box") => (templates.data ?? []).some(row => row.product_id === productId && row.sticker_level === level && (Array.isArray(row.current_version) ? row.current_version[0] : row.current_version)?.status === "approved");
  const stickerRows: StickerRow[] = stickerSheet.lines.map(line => { const product = productRow(keyOf(line.sku, "", line.ean));
    return { ...line, product: product ? productName(product.id) : null, requiresSticker: product ? Boolean(product.requires_sticker) : null, unitTemplate: product ? approved(product.id, "unit") : false, boxTemplate: product ? approved(product.id, "box") : false }; });

  const distributionFile = distributions.find(file => file.file_id === query.distribution) ?? distributions[0] ?? null;
  let distributionRows = sheets.distribution; let distributionSource = chosen.file_id; let distributionName = "Лист «Распределение» таблицы «Вн расчеты»"; let distributionError = "";
  if (distributionFile) {
    try {
      const reference = await shipmentDrive().scopedReference(distributionFile.file_id, AbortSignal.timeout(30000));
      if (reference.mimeType !== SHEET || !reference.ancestors?.includes(folderId)) throw new PublicError("Таблица распределения больше не лежит в папке поставки.");
      distributionRows = await readFirstSheet(distributionFile.file_id); distributionSource = distributionFile.file_id; distributionName = `Таблица «${distributionFile.name}»`;
    } catch (error) { distributionError = error instanceof PublicError ? error.message : "Не удалось прочитать таблицу распределения."; }
  }
  const distribution = parseDistributionSheet(distributionRows);
  const productOfLine = (line: { sku: string; factorySku: string; ean: string }) => keyOf(line.sku, line.factorySku, line.ean);
  const saleDestinations = distribution.destinations.filter(item => item.kind === "sale");
  const [customers, linked, lastSales] = saleDestinations.length && permissions["sales.view"] ? await Promise.all([
    selectAll((from, to) => supabase.from("counterparties").select("id,legal_name,short_name,roles").eq("status", "active").order("legal_name").order("id").range(from, to)),
    supabase.from("shipment_distribution_orders").select("customer_id,sale_id").eq("shipment_id", id),
    supabase.from("sales").select("customer_id,currency_id,created_at").order("created_at", { ascending: false }).limit(500),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const customerList = (customers.data ?? []).filter(party => party.roles?.includes("customer"));
  const linkedSales = (linked.data ?? []).length ? (await supabase.from("sales").select("id,sale_number").in("id", (linked.data ?? []).map(row => row.sale_id))).data ?? [] : [];
  const sales: SaleTarget[] = saleDestinations.map(destination => {
    const customerId = matchCustomer(destination.name, customerList);
    const link = (linked.data ?? []).find(row => row.customer_id === customerId);
    const lines = distribution.lines.filter(line => line.quantities[destination.column]);
    const items = new Map<string, number>(); let unmatched = 0;
    for (const line of lines) { const productId = productOfLine(line); if (!productId) { unmatched++; continue; } items.set(productId, (items.get(productId) ?? 0) + line.quantities[destination.column]); }
    return { column: destination.column, label: destination.label, customerId,
      existing: link ? { saleId: link.sale_id, number: linkedSales.find(sale => sale.id === link.sale_id)?.sale_number ?? "заказ" } : null,
      currencyId: (lastSales.data ?? []).find(sale => sale.customer_id === customerId)?.currency_id ?? shipment.currency_id ?? currencies.data?.[0]?.id ?? "",
      items: [...items].map(([productId, quantity]) => ({ productId, quantity })), unmatched };
  });
  const today = businessToday();
  const defaultDate = shipment.planned_arrival_date && shipment.planned_arrival_date > today ? shipment.planned_arrival_date : today;

  return shell(<>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Источник</p><h2>{chosen.name}</h2></div></div>
      <p className="form-help">Взяты: строки закупа листа «Расчеты» (артикул ARSEO, артикул завода, штрихкод, «Заказ, шт» и «Цена за ед, евро (INVOICE)»), даты над ними и лист «От клиента». Не взяты: продажные цены, «Экономика», «MasterData».</p>
      <dl className="form-grid">
        <div><dt>Дата погрузки на заводе</dt><dd>{date(workbook.loadingDate)} · в Nexus готовность: {date(shipment.planned_ready_date)}</dd></div>
        <div><dt>Дата выгрузки на РЦ клиента</dt><dd>{date(workbook.unloadingDate)} · только для сведения, в поставку не переносится</dd></div>
        <div><dt>Заказ клиента</dt><dd>{workbook.clientOrder.number ?? "—"} от {date(workbook.clientOrder.date)}</dd></div>
        <div><dt>Контракт клиента</dt><dd>{workbook.clientOrder.contract ?? "—"} от {date(workbook.clientOrder.contractDate)}</dd></div>
      </dl>
      {workbook.warnings.length > 0 && <ul className="login-error">{workbook.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </section>
    <form action={applyOrderWorkbook} className="panel admin-section">
      <input type="hidden" name="shipment_id" value={id}/><input type="hidden" name="file" value={chosen.file_id}/>
      <div className="panel-heading"><div><p className="eyebrow">Сверка с поставкой</p><h2>Строки заказа поставщику ({workbook.lines.length})</h2></div></div>
      {readyChanges && <label className="check-label"><input type="checkbox" name="apply" value="ready_date" defaultChecked={!shipment.planned_ready_date}/> Плановая готовность товара: {date(shipment.planned_ready_date)} → {date(workbook.loadingDate)}<input type="hidden" name="ready_date" value={workbook.loadingDate ?? ""}/></label>}
      <div className="compact-list">{plans.map(plan => {
        const key = plan.kind === "add" ? `add:${plan.productId}` : plan.kind === "update" ? `update:${plan.itemId}` : "";
        const item = plan.kind === "update" ? existing.find(row => row.id === plan.itemId) : undefined;
        const keepPrice = plan.kind === "update" && item?.currency && item.currency !== eur;
        const price = keepPrice ? plan.price : plan.line.price ?? (plan.kind === "update" ? plan.price : null);
        return <div className="shipment-row" key={`${plan.line.row}`}>
          <div style={{ minWidth: 0 }}><strong>Строка {plan.line.row}: {plan.line.sku || plan.line.factorySku || plan.line.ean}</strong><small>{plan.line.name}</small></div>
          <div><strong>{kindLabel[plan.kind]}</strong><small>{plan.kind === "unknown" ? plan.reason : `${productName(plan.productId)} · по: ${plan.by}`}</small></div>
          <div><strong>{num(plan.line.quantity)} шт · {num(plan.line.price)} €</strong><small>{plan.kind === "update" ? `в Nexus: ${num(plan.quantity)} шт · ${num(plan.price)}` : plan.kind === "split" ? `в Nexus всего: ${num(plan.quantity)} шт` : ""}{keepPrice ? " · цена в другой валюте не меняется" : ""}</small></div>
          {key && !locked && <div><label className="check-label"><input type="checkbox" name="apply" value={key} defaultChecked/> Применить</label>
            <input type="hidden" name={`quantity:${key}`} value={plan.line.quantity}/><input type="hidden" name={`price:${key}`} value={price ?? ""}/>
            {plan.kind === "update" && <><input type="hidden" name={`seen_quantity:${key}`} value={plan.quantity}/><input type="hidden" name={`seen_price:${key}`} value={plan.price ?? ""}/></>}</div>}
        </div>;
      })}</div>
      {notInWorkbook.length > 0 && <p className="form-help">В поставке есть позиции, которых нет в таблице: {notInWorkbook.map(item => productName(item.product_id)).join("; ")}. Они не удаляются.</p>}
      {locked ? <div className="setup-notice">Поставка закрыта для изменений.</div> : changes.length || readyChanges ? <>
        <label className="check-label"><input type="checkbox" name="confirm" value="yes" required/> Проверил(а) изменения. Применить отмеченные к поставке</label>
        <PendingSubmitButton pendingText="Применяем…" className="primary" type="submit">Применить отмеченные</PendingSubmitButton></>
        : <p className="login-success">Поставка совпадает с таблицей: изменений нет.</p>}
    </form>
    <CustomsCheck lines={customsLines.length} issues={issues}/>
    <StickerCheck rows={stickerRows} size={stickerSheet.size} marking={stickerSheet.marking} templatesVisible={Boolean(permissions["stickers.view"])}/>
    <div id="distribution">
      {distributions.length > 1 && <p className="form-help">Таблицы распределения в папке: {distributions.map(file => <Link key={file.file_id} href={`/shipments/${id}/workbook?file=${encodeURIComponent(chosen.file_id)}&distribution=${encodeURIComponent(file.file_id)}#distribution`}>{file.name} </Link>)}</p>}
      {distributionError && <div className="login-error admin-message">{distributionError}</div>}
      <DistributionView shipmentId={id} file={chosen.file_id} source={distributionSource} sourceName={distributionName} distribution={distribution} over={overDistributed(distribution)}
        productOf={line => { const productId = productOfLine(line); return productId ? productName(productId) : null; }} sales={sales}
        customers={customerList.map(party => ({ id: party.id, name: party.short_name || party.legal_name }))} currencies={currencies.data ?? []} defaultDate={defaultDate} canOrder={Boolean(permissions["sales.manage"])}/>
    </div>
  </>, title);
}
