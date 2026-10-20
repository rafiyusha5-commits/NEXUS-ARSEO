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
import { processingErrorCode, processingErrors, processingDiagnostic, type ProcessingStage } from "@/lib/documents/processing-status";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const required = ["shipments.view", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;
async function context(form: FormData, ctx: Awaited<ReturnType<typeof requireUser>>) {
  const id = text(form, "shipment_id");
  if (!isUuid(id)) throw new Error("Некорректная поставка");
  const permissions = await loadPermissions(ctx.supabase, required);
  if (required.some(p => !permissions[p])) throw new Error("Недостаточно прав");
  const shipment = await ctx.supabase.from("shipments").select("id").eq("id", id).maybeSingle();
  if (!shipment.data || shipment.error) throw new Error("Поставка недоступна");
  return { ...ctx, id, db: await shipmentDriveGateway(ctx.supabase), drive: shipmentDrive(), signal: AbortSignal.timeout(90000) };
}
async function operation(form: FormData, kind: "bind" | "scan" | "import" | "check" | "link", work: (ctx: Awaited<ReturnType<typeof context>> & { operationId: string; report: (stage: ProcessingStage) => Promise<void> }) => Promise<string>) {
  const id = text(form, "shipment_id");
  if (!isUuid(id)) redirect("/shipments");
  // Preserve framework login/signout redirects; never turn them into a provider error.
  const user = await requireUser();
  let message = ""; let ok = false;
  const operationId = isUuid(text(form, "operation_id")) ? text(form, "operation_id") : randomUUID();
  const started = Date.now();
  let stage: ProcessingStage = "checking";
  let record: ((stage: ProcessingStage, state?: string, code?: string | null) => Promise<void>) | undefined;
  try {
    const ctx = await context(form, user);
    const claim = await ctx.db.rpc("begin_shipment_drive_operation", { p_id: operationId, p_shipment_id: id, p_kind: kind, p_file_id: text(form, "file_id"), p_revision: text(form, "revision") });
    if (claim.error || !claim.data) throw new Error(claim.error?.code === "42501" ? "Недостаточно прав" : "Не удалось начать операцию");
    if (claim.data.action === "completed") { message = "Эта операция уже завершена. Повторная запись не выполнялась."; ok = true; }
    else if (claim.data.action === "busy") { message = "Операция уже выполняется. Обновите страницу для проверки сохранённого состояния."; }
    else {
      record = async (next, state = "running", code = null) => {
        stage = next;
        const saved = await ctx.db.rpc("record_shipment_drive_operation", { p_id: operationId, p_attempt: claim.data.attempt, p_stage: next, p_state: state, p_error_code: code });
        if (saved.error) throw new Error(saved.error.code === "42501" ? "Недостаточно прав" : "Не удалось сохранить состояние операции");
      };
      message = await work({ ...ctx, operationId, report: record });
      await record("finished", "completed");
      ok = true;
    }
  }
  catch (error) {
    const code = processingErrorCode(error, stage);
    message = processingErrors[code];
    try { await record?.(stage, code === "SAVE_UNCERTAIN" ? "needs_action" : "failed", code); } catch { /* expired session/lease: UI derives needs_action after lease expiry */ }
    console.info("[document-processing]", processingDiagnostic(operationId, stage, started, Date.now(), code));
  }
  if (ok) console.info("[document-processing]", processingDiagnostic(operationId, stage, started, Date.now(), null));
  revalidatePath(`/shipments/${id}`);
  redirect(`/shipments/${id}?tab=documents&${ok ? "success" : "error"}=${encodeURIComponent(message)}#drive-folder`);
}
export async function bindShipmentDriveFolder(form: FormData) {
  await operation(form, "bind", async ({ id, db, drive, signal, report }) => {
    await report("reading");
    const folder = folderId(text(form, "folder"));
    if (folder === SHIPMENT_DRIVE_ROOT) throw new Error("Выберите папку отдельной поставки");
    const file = await drive.scopedReference(folder, signal);
    if (file.mimeType !== FOLDER_MIME) throw new Error("Выберите папку");
    await report("registering");
    const { error } = await db.rpc("bind_shipment_drive_folder", { p_shipment_id: id, p_folder_id: folder, p_name: file.name.slice(0, 255) });
    if (error) throw new Error("Не удалось сохранить привязку");
    return "Папка привязана. Нажмите «Проверить папку», чтобы найти документы.";
  });
}
export async function checkShipmentDriveFolder(form: FormData) {
  await operation(form, "scan", async ({ id, db, drive, signal, report }) => {
    const { data: binding, error } = await db.from("shipment_drive_folders").select("folder_id,generation").eq("shipment_id", id).single();
    if (error || !binding) throw new Error("Нет привязки");
    await report("reading");
    const files = await scanFolder(drive, binding.folder_id, signal);
    await report("registering");
    const saved = await db.rpc("scan_shipment_drive_folder", { p_shipment_id: id, p_generation: binding.generation, p_files: files });
    if (saved.error) throw new Error("Проверка не сохранена");
    return `Проверка завершена: ${files.length} файлов. Документы и подтверждённые данные Nexus не изменены.`;
  });
}
// Explicit content check only: no Storage write, recognition or document confirmation.
async function checkedContent(form: FormData, ctx: Awaited<ReturnType<typeof context>>) {
  const { id, db, drive, signal } = ctx;
  const [{ data: binding }, { data: source }] = await Promise.all([
    db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", id).single(),
    db.from("shipment_drive_files").select("file_id,revision,present").eq("shipment_id", id).eq("file_id", text(form, "file_id")).single(),
  ]);
  if (!binding || !source?.present || source.revision !== text(form, "revision")) throw new Error("Файл изменён. Повторите проверку папки");
  insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
  const { blob, filename } = await drive.download(source.file_id, signal);
  const check = checkDocumentFile({ name: filename, size: blob.size, type: "" });
  if (!check.ok) throw new Error("Не удалось проверить файл: " + check.error);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!matchesFileSignature(check.kind, bytes)) throw new Error("Не удалось проверить содержимое файла");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
  return { source, binding, checksum };
}
type StoredVersion = { id: string; document_id: string; version_number: number; storage_bucket: string; storage_path: string; file_size_bytes: number };
async function storedCandidates(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], checksum: string) {
  const candidates = await supabase.from("document_versions").select("id,document_id,version_number,storage_bucket,storage_path,file_size_bytes")
    .eq("is_current", true).eq("checksum_sha256", checksum).limit(21);
  if (candidates.error || (candidates.data?.length ?? 0) > 20) throw new Error("Не удалось проверить все совпадения. Требуется отдельный разбор документов.");
  return candidates.data ?? [];
}
async function verifyStoredBytes(ctx: Awaited<ReturnType<typeof context>>, version: StoredVersion, checksum: string) {
  ctx.signal.throwIfAborted();
  const visible = await ctx.supabase.from("documents").select("id,current_version").eq("id", version.document_id).is("archived_at", null).neq("status", "rejected").maybeSingle();
  if (visible.error || !visible.data || visible.data.current_version !== version.version_number ||
    version.storage_bucket !== DOCUMENT_BUCKET || version.file_size_bytes <= 0 || version.file_size_bytes > 4 * 1024 * 1024)
    throw new Error("Не удалось проверить выбранный документ");
  // Session-scoped download, never service_role. Metadata hashes are only candidate hints.
  const stored = await ctx.supabase.storage.from(DOCUMENT_BUCKET).download(version.storage_path);
  ctx.signal.throwIfAborted();
  if (stored.error || !stored.data || stored.data.size > 4 * 1024 * 1024 || stored.data.size !== version.file_size_bytes)
    throw new Error("Не удалось проверить содержимое выбранного документа");
  return createHash("sha256").update(new Uint8Array(await stored.data.arrayBuffer())).digest("hex") === checksum;
}
export async function checkShipmentDriveContent(form: FormData) {
  await operation(form, "check", async ctx => {
    await ctx.report("downloading");
    const { source, binding, checksum } = await checkedContent(form, ctx);
    const verified: string[] = [];
    for (const candidate of await storedCandidates(ctx.supabase, checksum)) {
      if (await verifyStoredBytes(ctx, candidate, checksum)) verified.push(candidate.id);
    }
    insideFolder(await ctx.drive.scopedReference(source.file_id, ctx.signal), binding.folder_id, source.revision);
    await ctx.report("registering");
    const saved = await ctx.db.rpc("check_shipment_drive_content", { p_shipment_id: ctx.id, p_file_id: source.file_id, p_revision: source.revision, p_checksum: checksum, p_verified_versions: verified });
    if (saved.error) throw new Error("Не удалось проверить и сохранить результат");
    return "Содержимое проверено по SHA-256. Просмотрите доступные совпадения; документы не изменены.";
  });
}
export async function linkShipmentDriveDocument(form: FormData) {
  await operation(form, "link", async ctx => {
    if (text(form, "confirm") !== "yes") throw new Error("Подтвердите загрузку связи с выбранным документом");
    const permissions = await loadPermissions(ctx.supabase, ["documents.create", "documents.update"] as const);
    if (!permissions["documents.create"] || !permissions["documents.update"]) throw new Error("Недостаточно прав");
    if (!isUuid(text(form, "document_id")) || !isUuid(text(form, "version_id"))) throw new Error("Не удалось проверить выбранный документ");
    await ctx.report("downloading");
    const { source, binding, checksum } = await checkedContent(form, ctx);
    const target = await ctx.supabase.from("document_versions").select("id,document_id,version_number,storage_bucket,storage_path,file_size_bytes")
      .eq("id", text(form, "version_id")).eq("document_id", text(form, "document_id")).eq("is_current", true).maybeSingle();
    if (target.error || !target.data || !await verifyStoredBytes(ctx, target.data, checksum))
      throw new Error("Не удалось проверить совпадение содержимого выбранного документа");
    insideFolder(await ctx.drive.scopedReference(source.file_id, ctx.signal), binding.folder_id, source.revision);
    await ctx.report("registering");
    const result = await ctx.db.rpc("link_shipment_drive_document", { p_shipment_id: ctx.id, p_file_id: source.file_id,
      p_revision: source.revision, p_checksum: checksum, p_document_id: text(form, "document_id"), p_version_id: text(form, "version_id") });
    if (result.error || !result.data) throw new Error("Не удалось проверить актуальность выбранной связи. Обновите варианты и проверьте документ.");
    revalidatePath("/documents");
    return "Связь сохранена. Документ, его версия и ручные подтверждения не изменены. Копия в Storage не создавалась.";
  });
}
export async function importShipmentDriveFile(form: FormData) {
  await operation(form, "import", async ctx => {
    const { id, supabase, db, drive, signal, report, operationId } = ctx;
    const permissions = await loadPermissions(supabase, ["documents.create", "documents.update"] as const);
    if (!permissions["documents.create"] || !permissions["documents.update"]) throw new Error("Недостаточно прав");
    if (text(form, "confirm") !== "yes") throw new Error("Подтвердите загрузку документа");
    const type = text(form, "document_type_id");
    if (!isUuid(type)) throw new Error("Укажите тип документа");
    const [{ data: binding }, { data: source }] = await Promise.all([
      db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", id).single(),
      db.from("shipment_drive_files").select("file_id,revision,present,imported_document_id,imported_revision").eq("shipment_id", id).eq("file_id", text(form, "file_id")).single(),
    ]);
    if (!binding || !source || !source.present || source.revision !== text(form, "revision")) throw new Error("Файл изменён. Сначала повторите проверку папки");
    if (source.imported_document_id) {
      // A saved receipt avoids a second upload, not the live-source boundary.
      // Recheck membership/revision before reporting a successful retry.
      insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
      const visible = await supabase.from("documents").select("id").eq("id", source.imported_document_id).maybeSingle();
      if (visible.error || !visible.data || source.imported_revision !== source.revision) throw new Error("Файл изменён или недоступен");
      return "Сохранённая квитанция импорта найдена. Повторная загрузка, версия и подтверждение не создавались.";
    }
    await report("downloading");
    insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
    const { blob, filename } = await drive.download(source.file_id, signal);
    insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
    const check = checkDocumentFile({ name: filename, size: blob.size, type: "" });
    if (!check.ok) throw new Error("Не удалось проверить файл: " + check.error);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!matchesFileSignature(check.kind, bytes)) throw new Error("Не удалось проверить содержимое файла");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    // The old upload action can also reuse a checksum match. Do not let it
    // bypass byte verification merely because the employee chose "upload".
    for (const candidate of await storedCandidates(supabase, checksum)) {
      if (!await verifyStoredBytes(ctx, candidate, checksum)) throw new Error("Не удалось проверить совпадение содержимого. Требуется отдельный разбор документа.");
    }
    const document = randomUUID();
    const path = buildDocumentStoragePath(document, normalizeFileName(filename), randomUUID().replaceAll("-", ""));
    const storage = supabase.storage.from(DOCUMENT_BUCKET);
    await report("storage");
    const upload = await storage.upload(path, bytes, { contentType: check.mimeType, upsert: false, metadata: { nexus_operation: operationId } });
    if (upload.error) throw new Error("Загрузка не выполнена");
    // Recheck current Drive membership/version immediately before registering the document.
    // On an uncertain RPC result retain the private upload: never delete a possibly registered file.
    insideFolder(await drive.scopedReference(source.file_id, signal), binding.folder_id, source.revision);
    await report("registering");
    const result = await db.rpc("import_shipment_drive_file", { p_shipment_id: id, p_file_id: source.file_id, p_revision: source.revision, p_checksum: checksum, p_document_id: document, p_type_id: type, p_storage_path: path, p_filename: filename });
    if (result.error || !result.data) throw new Error(result.error?.code === "42501" ? "Недостаточно прав" : "Документ не зарегистрирован");
    if (result.data !== document) await storage.remove([path]); // only our unused Nexus staging object
    revalidatePath("/documents");
    return result.data === document ? "Документ загружен для проверки. Распознавание и подтверждение выполняются отдельно." : "Этот файл уже есть в Nexus. Добавлена связь с существующим документом, дубль не создан.";
  });
}
