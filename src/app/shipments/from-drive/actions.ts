"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { isUuid } from "@/lib/documents/rules";
import { publicErrorMessage, ruleViolationMessage } from "@/lib/errors/public-message";
import { shipmentDrive } from "@/lib/google/drive-server";
import { isShipmentDriveRoot } from "@/lib/google/shipment-drive";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { folderId, FOLDER_MIME } from "@/lib/google/shipment-folder";
import { FROM_DRIVE_PERMISSIONS } from "@/lib/shipments/drive-order";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const back = (kind: "error" | "success", message: string, folder = "") =>
  `/shipments/from-drive?${folder ? `folder=${encodeURIComponent(folder)}&` : ""}${kind}=${encodeURIComponent(message)}`;
const optionalUuid = (form: FormData, key: string) => { const value = text(form, key); return isUuid(value) ? value : null; };
const date = (form: FormData, key: string) => { const value = text(form, key); return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; };

/** One button: creates the shipment with its stages and binds the chosen Drive folder to it. Drive is only read. */
export async function createShipmentFromDrive(form: FormData) {
  const { profile, supabase } = await requireUser();
  let folder = "";
  try { folder = folderId(text(form, "folder")); } catch { redirect(back("error", "Выберите папку заказа")); }
  const permissions = await loadPermissions(supabase, FROM_DRIVE_PERMISSIONS);
  if (FROM_DRIVE_PERMISSIONS.some(code => !permissions[code])) redirect(back("error", "Недостаточно прав для создания поставки из папки", folder));
  if (isShipmentDriveRoot(folder)) redirect(back("error", "Выберите папку отдельного заказа, а не общую папку"));

  const type = text(form, "type");
  const supplierId = optionalUuid(form, "supplier_id"), customerId = optionalUuid(form, "customer_id");
  const routeId = optionalUuid(form, "route_id"), currencyId = optionalUuid(form, "currency_id"), warehouseId = optionalUuid(form, "warehouse_id");
  if (!["import", "export", "domestic_transfer"].includes(type)) redirect(back("error", "Выберите тип поставки", folder));
  if (type === "import" && !supplierId) redirect(back("error", "Для импорта выберите поставщика", folder));
  if (type === "export" && !customerId) redirect(back("error", "Для экспорта выберите клиента", folder));
  if (!routeId || !currencyId || !warehouseId) redirect(back("error", "Заполните маршрут, склад и валюту", folder));

  let name = "";
  let gateway: Awaited<ReturnType<typeof shipmentDriveGateway>>;
  try {
    gateway = await shipmentDriveGateway(supabase);
    const file = await shipmentDrive().scopedReference(folder, AbortSignal.timeout(30000));
    if (file.mimeType !== FOLDER_MIME) throw new Error("not a folder");
    name = file.name.slice(0, 255);
  } catch { redirect(back("error", "Папка не найдена в разрешённых папках Google Drive или Drive недоступен", folder)); }
  const bound = await gateway.from("shipment_drive_folders").select("shipment_id").eq("folder_id", folder).limit(1);
  if (bound.error) redirect(back("error", "Не удалось проверить, привязана ли папка", folder));
  if (bound.data?.length) redirect(`/shipments/${bound.data[0].shipment_id}?tab=documents&error=${encodeURIComponent("Эта папка уже привязана к поставке")}#drive-folder`);

  const responsible = optionalUuid(form, "responsible_user_id") ?? profile.id;
  const { data: id, error } = await supabase.rpc("create_shipment_with_stages", {
    p_project_code: text(form, "project_code").slice(0, 120), p_type: type, p_supplier_id: supplierId, p_customer_id: customerId,
    p_route_id: routeId, p_currency_id: currencyId, p_warehouse_id: warehouseId, p_responsible_user_id: responsible,
    p_planned_ready_date: date(form, "planned_ready_date"), p_planned_arrival_date: date(form, "planned_arrival_date"),
  });
  if (error || !id) redirect(back("error", publicErrorMessage(error, "Не удалось создать поставку."), folder));
  revalidatePath("/shipments"); revalidatePath("/");
  const bind = await gateway.rpc("bind_shipment_drive_folder", { p_shipment_id: id, p_folder_id: folder, p_name: name });
  if (bind.error) redirect(`/shipments/${id}?tab=documents&error=${encodeURIComponent("Поставка создана, но папку привязать не удалось. Привяжите её здесь по ссылке на папку")}#drive-folder`);
  redirect(`/shipments/${id}?tab=documents&success=${encodeURIComponent("Поставка создана, папка Drive привязана. Нажмите «Проверить папку», чтобы увидеть документы")}#drive-folder`);
}

export async function saveOrderPrefix(form: FormData) {
  const { supabase } = await requireUser();
  const target = text(form, "target");
  const own = target === "own";
  if (!own && !isUuid(target)) redirect(back("error", "Выберите клиента или «Свои склады»"));
  const { error } = await supabase.rpc("set_order_prefix", { p_prefix: text(form, "prefix"), p_counterparty_id: own ? null : target, p_is_own_stock: own, p_note: text(form, "note") || null });
  if (error) redirect(back("error", ruleViolationMessage(error, "Не удалось сохранить префикс")));
  revalidatePath("/shipments/from-drive");
  redirect(back("success", "Префикс сохранён"));
}

export async function deleteOrderPrefix(form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("remove_order_prefix", { p_prefix: text(form, "prefix") });
  if (error) redirect(back("error", ruleViolationMessage(error, "Не удалось удалить префикс")));
  revalidatePath("/shipments/from-drive");
  redirect(back("success", "Префикс удалён"));
}
