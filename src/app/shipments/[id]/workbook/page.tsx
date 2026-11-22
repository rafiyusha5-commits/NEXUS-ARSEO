import Link from "next/link";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireUser } from "@/lib/auth/access";
import { isUuid } from "@/lib/documents/rules";
import { loadPermissions } from "@/lib/permissions";
import { selectAll } from "@/lib/supabase/select-all";
import { shipmentDrive } from "@/lib/google/drive-server";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { readOrderWorkbookSheets } from "@/lib/google/order-workbook-sheet";
import { PublicError } from "@/lib/errors/public-message";
import { isOrderWorkbook, parseOrderWorkbook, planLines, type LinePlan, type OrderWorkbook, type ProductKeys } from "@/lib/shipments/order-workbook";
import { applyOrderWorkbook } from "./actions";

const REQUIRED = ["shipments.view", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;
const SHEET = "application/vnd.google-apps.spreadsheet";
type Params = { file?: string; error?: string; success?: string };
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
  const permissions = await loadPermissions(supabase, REQUIRED);
  if (REQUIRED.some(code => !permissions[code])) return shell(<div className="setup-notice">Нужны права на изменение поставки, документы Google Drive и закупочные цены.</div>);
  const { data: shipment } = await supabase.from("shipments").select("id,shipment_number,project_code,supplier_id,planned_ready_date,planned_arrival_date,is_locked,status").eq("id", id).maybeSingle();
  if (!shipment) return shell(<div className="setup-notice">Поставка недоступна.</div>);
  const title = `«Вн расчеты» · ${shipment.shipment_number}`;

  let workbooks: { file_id: string; name: string }[] = []; let folderId = "";
  try {
    const db = await shipmentDriveGateway(supabase);
    const [binding, files] = await Promise.all([
      db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", id).maybeSingle(),
      db.from("shipment_drive_files").select("file_id,name,mime_type,present").eq("shipment_id", id).eq("present", true).limit(1000),
    ]);
    if (binding.error || files.error) throw new Error("unavailable");
    folderId = binding.data?.folder_id ?? "";
    workbooks = (files.data ?? []).filter(file => isOrderWorkbook(file.name, file.mime_type));
  } catch { return shell(<div className="setup-notice">Привязка Google Drive сейчас недоступна.</div>, title); }
  if (!folderId) return shell(<div className="setup-notice">К поставке не привязана папка Google Drive.</div>, title);
  if (!workbooks.length) return shell(<div className="setup-notice">В сохранённом списке папки нет таблицы «Вн расчеты». Нажмите «Обновить из Drive» на вкладке «Документы» и откройте эту страницу снова.</div>, title);
  const chosen = workbooks.find(file => file.file_id === query.file) ?? (workbooks.length === 1 ? workbooks[0] : null);
  if (!chosen) return shell(<section className="panel admin-section"><h2>Выберите таблицу</h2><ul>{workbooks.map(file => <li key={file.file_id}><Link href={`/shipments/${id}/workbook?file=${encodeURIComponent(file.file_id)}`}>{file.name}</Link></li>)}</ul></section>, title);

  // The sheet must still lie inside the bound folder before anything is read from it.
  let workbook: OrderWorkbook;
  try {
    const reference = await shipmentDrive().scopedReference(chosen.file_id, AbortSignal.timeout(30000));
    if (reference.mimeType !== SHEET || !reference.ancestors?.includes(folderId)) throw new PublicError("Таблица больше не лежит в папке поставки. Обновите папку из Drive.");
    const sheets = await readOrderWorkbookSheets(chosen.file_id);
    workbook = parseOrderWorkbook(sheets.calculation, sheets.client);
  } catch (error) {
    const message = error instanceof PublicError || (error instanceof Error && /^В листе/.test(error.message)) ? error.message : "Не удалось прочитать таблицу. Проверьте доступ к папке и повторите.";
    return shell(<div className="login-error admin-message">{message}</div>, title);
  }

  const [products, identifiers, items, prices, currencies] = await Promise.all([
    selectAll((from, to) => supabase.from("products").select("id,internal_sku,name").order("id").range(from, to)),
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
  </>, title);
}
