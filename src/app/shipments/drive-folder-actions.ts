"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { isUuid } from "@/lib/documents/rules";
import { buildDocumentStoragePath, checkDocumentFile, matchesFileSignature, normalizeFileName, DOCUMENT_BUCKET } from "@/lib/documents/files";
import { shipmentDrive, SHIPMENT_DRIVE_ROOT } from "@/lib/google/drive-server";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { folderId, FOLDER_MIME, insideFolder, scanFolder } from "@/lib/google/shipment-folder";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const required = ["shipments.view", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;
async function context(form: FormData) {
  const ctx = await requireUser();
  const id = text(form, "shipment_id");
  if (!isUuid(id)) throw new Error("Некорректная поставка");
  const permissions = await loadPermissions(ctx.supabase, required);
  if (required.some(p => !permissions[p])) throw new Error("Недостаточно прав");
  const shipment = await ctx.supabase.from("shipments").select("id").eq("id", id).maybeSingle();
  if (!shipment.data || shipment.error) throw new Error("Поставка недоступна");
  return { ...ctx, id, db: await shipmentDriveGateway(ctx.supabase), drive: shipmentDrive(), signal: AbortSignal.timeout(90000) };
}
async function operation(form: FormData, work: (ctx: Awaited<ReturnType<typeof context>>) => Promise<string>) {
  const id = text(form, "shipment_id");
  if (!isUuid(id)) redirect("/shipments");
  let message = ""; let ok = false;
  try { message = await work(await context(form)); ok = true; }
  catch (error) {
    // Do not expose provider responses, tokens, SQL, filenames from a denied document, etc.
    const known = ["Недостаточно прав", "Вставьте ссылку", "Выберите папку", "Папка слишком", "В папке больше", "Слишком много", "Состав папки", "Файл изменён", "Документ уже загружен", "Не удалось проверить", "Подключение Drive", "Укажите тип", "Подтвердите загрузку"];
    message = error instanceof Error && known.some(prefix => error.message.startsWith(prefix)) ? error.message : "Не удалось выполнить действие. Проверьте доступ к папке и повторите проверку. Сохранённые документы не изменены.";
  }
  revalidatePath(`/shipments/${id}`);
  redirect(`/shipments/${id}?tab=documents&${ok ? "success" : "error"}=${encodeURIComponent(message)}#drive-folder`);
}
export async function bindShipmentDriveFolder(form: FormData) {
  await operation(form, async ({ id, db, drive, signal }) => {
    const folder = folderId(text(form, "folder"));
    if (folder === SHIPMENT_DRIVE_ROOT) throw new Error("Выберите папку отдельной поставки");
    const file = await drive.scopedReference(folder, signal);
    if (file.mimeType !== FOLDER_MIME) throw new Error("Выберите папку");
    const { error } = await db.rpc("bind_shipment_drive_folder", { p_shipment_id: id, p_folder_id: folder, p_name: file.name.slice(0, 255) });
    if (error) throw new Error("Не удалось сохранить привязку");
    return "Папка привязана. Нажмите «Проверить папку», чтобы найти документы.";
  });
}
export async function checkShipmentDriveFolder(form: FormData) {
  await operation(form, async ({ id, db, drive, signal }) => {
    const { data: binding, error } = await db.from("shipment_drive_folders").select("folder_id,generation").eq("shipment_id", id).single();
    if (error || !binding) throw new Error("Нет привязки");
    const files = await scanFolder(drive, binding.folder_id, signal);
    const saved = await db.rpc("scan_shipment_drive_folder", { p_shipment_id: id, p_generation: binding.generation, p_files: files });
    if (saved.error) throw new Error("Проверка не сохранена");
    return `Проверка завершена: ${files.length} файлов. Документы и подтверждённые данные Nexus не изменены.`;
  });
}
export async function importShipmentDriveFile(form: FormData) {
  await operation(form, async ({ id, supabase, db, drive, signal }) => {
    const permissions = await loadPermissions(supabase, ["documents.create", "documents.update"] as const);
    if (!permissions["documents.create"] || !permissions["documents.update"]) throw new Error("Недостаточно прав");
    if (text(form, "confirm") !== "yes") throw new Error("Подтвердите загрузку документа");
    const type = text(form, "document_type_id");
    if (!isUuid(type)) throw new Error("Укажите тип документа");
    const [{ data: binding }, { data: source }] = await Promise.all([
      db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", id).single(),
      db.from("shipment_drive_files").select("file_id,revision,present,imported_document_id").eq("shipment_id", id).eq("file_id", text(form, "file_id")).single(),
    ]);
    if (!binding || !source || !source.present || source.revision !== text(form, "revision")) throw new Error("Файл изменён. Сначала повторите проверку папки");
    if (source.imported_document_id) throw new Error("Документ уже загружен. Повторная загрузка не нужна; изменения согласуются отдельно.");
    insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
    const { blob, filename } = await drive.download(source.file_id, signal);
    insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
    const check = checkDocumentFile({ name: filename, size: blob.size, type: "" });
    if (!check.ok) throw new Error("Не удалось проверить файл: " + check.error);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!matchesFileSignature(check.kind, bytes)) throw new Error("Не удалось проверить содержимое файла");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const document = randomUUID();
    const path = buildDocumentStoragePath(document, normalizeFileName(filename), randomUUID().replaceAll("-", ""));
    const storage = supabase.storage.from(DOCUMENT_BUCKET);
    const upload = await storage.upload(path, bytes, { contentType: check.mimeType, upsert: false });
    if (upload.error) throw new Error("Загрузка не выполнена");
    // Recheck current Drive membership/version immediately before registering the document.
    // On an uncertain RPC result retain the private upload: never delete a possibly registered file.
    insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
    const result = await db.rpc("import_shipment_drive_file", { p_shipment_id: id, p_file_id: source.file_id, p_revision: source.revision, p_checksum: checksum, p_document_id: document, p_type_id: type, p_storage_path: path, p_filename: filename });
    if (result.error || !result.data) throw new Error("Документ не зарегистрирован");
    if (result.data !== document) await storage.remove([path]); // only our unused Nexus staging object
    revalidatePath("/documents");
    return result.data === document ? "Документ загружен для проверки. Распознавание и подтверждение выполняются отдельно." : "Этот файл уже есть в Nexus. Добавлена связь с существующим документом, дубль не создан.";
  });
}
