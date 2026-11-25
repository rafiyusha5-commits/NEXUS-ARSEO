import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requirePageUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { selectAll } from "@/lib/supabase/select-all";
import type { DriveFile } from "@/lib/google/drive-readonly";
import { shipmentDrive } from "@/lib/google/drive-server";
import { FUTURE_ORDERS_DRIVE_ROOT, isShipmentDriveRoot } from "@/lib/google/shipment-drive";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { folderId, FOLDER_MIME } from "@/lib/google/shipment-folder";
import { FROM_DRIVE_PERMISSIONS, orderCodes, suggestFromFolder, suggestRoute, type OrderPrefix } from "@/lib/shipments/drive-order";
import { createShipmentFromDrive, deleteOrderPrefix, saveOrderPrefix } from "./actions";

type Params = { folder?: string; error?: string; success?: string };
function localizedName(value: unknown) { if (!value || typeof value !== "object") return "—"; const name = value as Record<string, unknown>; return String(name.ru ?? name.en ?? "—"); }

/** Folders directly inside a folder of the approved shipment trees; at most three pages of one hundred. */
async function childFolders(id: string): Promise<{ folder: DriveFile; children: DriveFile[] }> {
  const drive = shipmentDrive(); const signal = AbortSignal.timeout(30000);
  const folder = await drive.scopedReference(id, signal);
  if (folder.mimeType !== FOLDER_MIME) throw new Error("not a folder");
  const children: DriveFile[] = []; let page = "";
  for (let index = 0; index < 3; index++) {
    const result = await drive.catalogPage({ id, path: "", depth: 0, ancestors: folder.ancestors ?? [], page }, signal);
    children.push(...result.files.filter(file => file.mimeType === FOLDER_MIME));
    if (!result.nextPage) break; page = result.nextPage;
  }
  return { folder, children };
}

export default async function ShipmentFromDrivePage({ searchParams }: { searchParams: Promise<Params> }) {
  const { profile, roles, supabase } = await requirePageUser(); const params = await searchParams;
  const permissions = await loadPermissions(supabase, FROM_DRIVE_PERMISSIONS);
  const shell = (body: React.ReactNode) => <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Поступления и поставки</p><h1>Создать поставку из папки Drive</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/shipments">К поставкам</Link></div></header>
    {params.error && <div className="login-error admin-message">{params.error}</div>}{params.success && <div className="login-success admin-message">{params.success}</div>}
    {body}</section></main>;
  if (FROM_DRIVE_PERMISSIONS.some(code => !permissions[code])) return shell(<div className="setup-notice">Для создания поставки из папки нужны права на поставки, документы Google Drive и закупочные цены.</div>);

  const [{ data: prefixRows }, { data: counterparties }, { data: routes }, { data: warehouses }, { data: currencies }, { data: people }] = await Promise.all([
    supabase.from("order_prefixes").select("prefix,counterparty_id,is_own_stock,note").order("prefix"),
    selectAll((from, to) => supabase.from("counterparties").select("id,legal_name,short_name,roles,country").eq("status", "active").order("legal_name").order("id").range(from, to)),
    supabase.from("routes").select("id,name,origin_country,destination_country").eq("status", "active").order("origin_country"),
    supabase.from("warehouses").select("id,code,name").eq("status", "active").eq("is_virtual", false).order("code"),
    supabase.from("currencies").select("id,code").eq("is_active", true).order("code"),
    supabase.from("profiles").select("id,full_name").eq("is_active", true).order("full_name"),
  ]);
  const prefixes: OrderPrefix[] = prefixRows ?? [];
  const suppliers = counterparties?.filter(party => party.roles?.includes("manufacturer")) ?? [];
  const customers = counterparties?.filter(party => party.roles?.includes("customer")) ?? [];
  const partyName = (id: string | null) => { const party = counterparties?.find(item => item.id === id); return party ? party.short_name || party.legal_name : "клиент не найден"; };

  // The list of order folders, without the folders already bound to a shipment.
  let list: DriveFile[] = []; let listError = false; const bound = new Map<string, string>();
  try {
    const [future, binding] = await Promise.all([childFolders(FUTURE_ORDERS_DRIVE_ROOT), (await shipmentDriveGateway(supabase)).from("shipment_drive_folders").select("shipment_id,folder_id")]);
    for (const row of binding.data ?? []) bound.set(row.folder_id, row.shipment_id);
    list = future.children;
  } catch { listError = true; }

  // The chosen folder: its name and the names of its direct subfolders give the suggestions.
  const selectedId = (() => { try { const id = folderId(params.folder ?? ""); return isShipmentDriveRoot(id) ? "" : id; } catch { return ""; } })();
  let selected: { folder: DriveFile; children: DriveFile[] } | null = null; let selectedError = false;
  if (selectedId) { try { selected = await childFolders(selectedId); } catch { selectedError = true; } }
  const suggestion = selected ? suggestFromFolder(selected.folder.name, selected.children.map(child => child.name), prefixes, suppliers) : null;
  const supplierId = suggestion?.supplierIds.length === 1 ? suggestion.supplierIds[0] : "";
  const last = supplierId ? (await supabase.from("shipments").select("currency_id,route_id").eq("supplier_id", supplierId).order("created_at", { ascending: false }).limit(1).maybeSingle()).data : null;
  const supplierCountry = suppliers.find(party => party.id === supplierId)?.country;
  const routeId = last?.route_id ?? suggestRoute(supplierCountry, routes ?? []) ?? "";
  const warehouseId = warehouses?.find(warehouse => warehouse.code === "AKT")?.id ?? "";
  const customerId = suggestion && !suggestion.ownStock && suggestion.customers.length === 1 ? suggestion.customers[0] : "";
  const alreadyBound = selectedId ? bound.get(selectedId) : undefined;

  return shell(<>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Шаг 1</p><h2>Папка заказа</h2></div></div>
      <p className="form-help">Папки из «Будущих заказов» на Google Drive. Nexus только читает Drive: папки и файлы там не меняются.</p>
      {listError && <div className="setup-notice">Не удалось прочитать «Будущие заказы» на Google Drive. Вставьте ссылку на папку ниже.</div>}
      <div className="shipment-list">{list.map(folder => { const codes = orderCodes(folder.name, prefixes); const shipment = bound.get(folder.id);
        return shipment ? <Link className="shipment-row" key={folder.id} href={`/shipments/${shipment}?tab=documents#drive-folder`}><div><strong>{folder.name}</strong><small>Уже привязана к поставке — открыть</small></div></Link>
          : <Link className="shipment-row" key={folder.id} href={`/shipments/from-drive?folder=${encodeURIComponent(folder.id)}`}><div><strong>{folder.name}</strong><small>{codes.length ? codes.map(code => code.code).join(", ") : "Код заказа не распознан"}</small></div></Link>; })}
        {!list.length && !listError && <div className="empty-state">В «Будущих заказах» нет папок.</div>}</div>
      <form method="get" action="/shipments/from-drive" className="shipment-form"><label className="doc-form-full">Или ссылка на папку Google Drive (например, из архива)<input name="folder" placeholder="https://drive.google.com/drive/folders/…"/></label><button className="ghost" type="submit">Открыть папку</button></form>
    </section>

    {params.folder && !selectedId && <div className="login-error admin-message">Вставьте ссылку на папку отдельного заказа.</div>}
    {selectedError && <div className="login-error admin-message">Папка не найдена в разрешённых папках Google Drive.</div>}
    {selected && suggestion && <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Шаг 2</p><h2>{selected.folder.name}</h2></div></div>
      {alreadyBound ? <div className="setup-notice">Эта папка уже привязана к поставке. <Link href={`/shipments/${alreadyBound}?tab=documents#drive-folder`}>Открыть поставку</Link></div> : <>
      <p className="form-help">Поля заполнены по названию папки и вложенных папок. Проверьте и исправьте при необходимости.</p>
      {suggestion.codes.length > 0 && <ul>{suggestion.codes.map(code => <li key={code.code}>{code.code} — {code.own ? "свои склады" : partyName(code.counterparty_id)}</li>)}</ul>}
      {suggestion.supplierIds.length > 1 && <p className="form-help">По названию подходит несколько поставщиков — выберите нужного.</p>}
      <form action={createShipmentFromDrive} className="shipment-form">
        <input type="hidden" name="folder" value={selected.folder.id}/>
        <label>Код проекта<input name="project_code" defaultValue={orderCodes(selected.folder.name, prefixes).map(code => code.code).join(", ") || suggestion.projectCode}/></label>
        <label>Тип<select name="type" defaultValue="import"><option value="import">Импорт</option><option value="export">Экспорт</option><option value="domestic_transfer">Перемещение по Казахстану</option></select></label>
        <label>Поставщик<select name="supplier_id" defaultValue={supplierId}><option value="">Выберите</option>{suppliers.map(party => <option key={party.id} value={party.id}>{party.short_name || party.legal_name}</option>)}</select></label>
        <label>Клиент<select name="customer_id" defaultValue={customerId}><option value="">Не выбран</option>{customers.map(party => <option key={party.id} value={party.id}>{party.short_name || party.legal_name}</option>)}</select></label>
        <label>Маршрут (обязательно)<select name="route_id" required defaultValue={routeId}><option value="" disabled>Выберите маршрут</option>{routes?.map(route => <option key={route.id} value={route.id}>{localizedName(route.name)}</option>)}</select></label>
        <label>Склад назначения (обязательно)<select name="warehouse_id" required defaultValue={warehouseId}><option value="" disabled>Выберите склад</option>{warehouses?.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{localizedName(warehouse.name)}</option>)}</select></label>
        <label>Валюта (обязательно)<select name="currency_id" required defaultValue={last?.currency_id ?? ""}><option value="" disabled>Выберите валюту</option>{currencies?.map(currency => <option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label>
        <label>Ответственный<select name="responsible_user_id" defaultValue={profile.id}>{people?.map(person => <option key={person.id} value={person.id}>{person.full_name}</option>)}</select></label>
        <label>Готовность товара<input name="planned_ready_date" type="date"/></label><label>Прибытие в Казахстан<input name="planned_arrival_date" type="date"/></label>
        <PendingSubmitButton pendingText="Создаём…" className="primary" type="submit">Создать поставку и привязать папку</PendingSubmitButton>
      </form>
      <p className="form-help">Будут созданы поставка с номером и этапами процесса и привязка этой папки. Документы из папки загружаются отдельно, после проверки папки.</p></>}
    </section>}

    <details id="prefixes" className="panel admin-section create-disclosure"><summary><span><small>Справочник</small><strong>Префиксы заказов ({prefixes.length})</strong></span><b aria-hidden="true">+</b></summary><div className="create-disclosure-body">
      <p className="form-help">Буквы в начале названия папки указывают клиента заказа, например «AB-12» — заказ клиента с префиксом AB.</p>
      <div className="shipment-list">{prefixes.map(item => <div className="shipment-row" key={item.prefix}><div><strong>{item.prefix}</strong><small>{item.is_own_stock ? "Свои склады" : partyName(item.counterparty_id)}</small></div>
        <form action={deleteOrderPrefix}><input type="hidden" name="prefix" value={item.prefix}/><PendingSubmitButton pendingText="Удаляем…" className="ghost" type="submit">Удалить</PendingSubmitButton></form></div>)}
        {!prefixes.length && <div className="empty-state">Префиксов пока нет. Добавьте их ниже.</div>}</div>
      <form action={saveOrderPrefix} className="shipment-form">
        <label>Префикс<input name="prefix" required pattern="[A-Za-z]{1,12}" placeholder="AB"/></label>
        <label>Клиент<select name="target" required defaultValue=""><option value="" disabled>Выберите</option><option value="own">Свои склады (без клиента)</option>{customers.map(party => <option key={party.id} value={party.id}>{party.short_name || party.legal_name}</option>)}</select></label>
        <label>Примечание<input name="note" maxLength={200}/></label>
        <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить префикс</PendingSubmitButton>
      </form>
    </div></details>
  </>);
}
