// Server-side template operations behind a gateway, so the rules are unit-tested
// without Supabase. The database enforces the same rules again (RLS and triggers).

import { checkDocumentFile, matchesFileSignature } from "../documents/files.ts";
import { describeStorageFailure, type StorageFailure, type UploadedFile } from "../documents/operations.ts";
import {
  type TemplateMetadata,
  buildTemplateStoragePath,
  validateTemplateMetadata,
  variablesToSchema,
} from "./rules.ts";

export const TEMPLATE_SIGNED_URL_TTL_SECONDS = 60;

export type TemplatePermissions = {
  view: boolean;
  create: boolean;
  update: boolean;
  upload: boolean;
  archive: boolean;
  approve: boolean;
  change_status: boolean;
  export: boolean;
};

export type RegisterTemplateCall = {
  template_id: string;
  document_type_id: string;
  name: string;
  language: string;
  purpose: string | null;
  counterparty_id: string | null;
  variables_schema: Record<string, unknown>;
  storage_path: string;
  original_filename: string;
  checksum_sha256: string;
};

export type TemplateGateway = {
  permissions(): Promise<TemplatePermissions>;
  getTemplateState(templateId: string): Promise<{ archived: boolean; checksums: string[] } | null>;
  uploadFile(path: string, bytes: Uint8Array, contentType: string): Promise<StorageFailure | null>;
  removeFile(path: string): Promise<void>;
  registerTemplate(input: RegisterTemplateCall): Promise<string | null>;
  insertVersion(input: { template_id: string; storage_path: string; original_filename: string; checksum_sha256: string; comment: string | null }): Promise<string | null>;
  getVersionFile(templateId: string, versionId: string | null): Promise<{ path: string; filename: string; versionNumber: number } | null>;
  createSignedUrl(path: string, expiresInSeconds: number, downloadName: string): Promise<string | null>;
  recordDownload(templateId: string, versionNumber: number): Promise<void>;
};

export type TemplateDeps = {
  newId(): string;
  randomHex(): string;
  sha256Hex(bytes: Uint8Array): Promise<string>;
};

type Result<T> = { ok: true; value: T } | { ok: false; code: string; error: string };
const fail = (code: string, error: string): Result<never> => ({ ok: false, code, error });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readCheckedFile(file: UploadedFile) {
  const reported = checkDocumentFile(file);
  if (!reported.ok) return { error: reported.error };
  const bytes = await file.bytes();
  const actual = checkDocumentFile({ name: file.name, size: bytes.byteLength, type: file.type });
  if (!actual.ok) return { error: actual.error };
  if (!matchesFileSignature(reported.kind, bytes)) return { error: "Содержимое файла не соответствует его типу" };
  return { bytes, mimeType: reported.mimeType };
}

export async function registerTemplateWithFile(
  gateway: TemplateGateway,
  deps: TemplateDeps,
  metadata: TemplateMetadata,
  file: UploadedFile,
): Promise<Result<string>> {
  const can = await gateway.permissions();
  if (!can.create) return fail("forbidden", "Недостаточно прав для создания шаблона");
  const error = validateTemplateMetadata(metadata);
  if (error) return fail("invalid", error);

  const checked = await readCheckedFile(file);
  if ("error" in checked) return fail("invalid", checked.error ?? "Некорректный файл");

  const templateId = deps.newId().toLowerCase();
  const path = buildTemplateStoragePath(templateId, file.name, deps.randomHex());
  const checksum = await deps.sha256Hex(checked.bytes);

  const uploadFailure = await gateway.uploadFile(path, checked.bytes, checked.mimeType);
  if (uploadFailure) {
    const described = describeStorageFailure(uploadFailure);
    return fail(described.code, described.error);
  }

  const registerError = await gateway.registerTemplate({
    template_id: templateId,
    document_type_id: metadata.document_type_id,
    name: metadata.name.trim(),
    language: metadata.language,
    purpose: metadata.purpose?.trim() || null,
    counterparty_id: metadata.counterparty_id,
    variables_schema: variablesToSchema(metadata.variables),
    storage_path: path,
    original_filename: file.name.slice(0, 255),
    checksum_sha256: checksum,
  });
  if (registerError) {
    await gateway.removeFile(path);
    return fail("failed", `Шаблон не создан: ${registerError}`);
  }
  return { ok: true, value: templateId };
}

export async function addTemplateVersion(
  gateway: TemplateGateway,
  deps: TemplateDeps,
  templateId: string,
  file: UploadedFile,
  comment: string | null,
): Promise<Result<null>> {
  if (!UUID.test(templateId)) return fail("invalid", "Некорректный шаблон");
  const can = await gateway.permissions();
  if (!can.upload) return fail("forbidden", "Недостаточно прав для загрузки новой версии шаблона");
  const state = await gateway.getTemplateState(templateId);
  if (!state) return fail("not_found", "Шаблон не найден");
  if (state.archived) return fail("archived", "Шаблон в архиве: новые версии запрещены");
  if (comment && comment.length > 1000) return fail("invalid", "Комментарий не должен быть длиннее 1000 символов");

  const checked = await readCheckedFile(file);
  if ("error" in checked) return fail("invalid", checked.error ?? "Некорректный файл");
  const checksum = await deps.sha256Hex(checked.bytes);
  if (state.checksums.includes(checksum)) return fail("duplicate", "Этот файл уже загружен как версия шаблона");

  const path = buildTemplateStoragePath(templateId.toLowerCase(), file.name, deps.randomHex());
  const uploadFailure = await gateway.uploadFile(path, checked.bytes, checked.mimeType);
  if (uploadFailure) {
    const described = describeStorageFailure(uploadFailure);
    return fail(described.code, described.error);
  }
  const insertError = await gateway.insertVersion({
    template_id: templateId,
    storage_path: path,
    original_filename: file.name.slice(0, 255),
    checksum_sha256: checksum,
    comment: comment?.trim() || null,
  });
  if (insertError) {
    await gateway.removeFile(path);
    return fail("failed", `Версия не сохранена: ${insertError}`);
  }
  return { ok: true, value: null };
}

export async function createTemplateDownloadUrl(
  gateway: TemplateGateway,
  templateId: string,
  versionId: string | null,
): Promise<Result<string>> {
  if (!UUID.test(templateId) || (versionId !== null && !UUID.test(versionId))) return fail("invalid", "Некорректная ссылка");
  const can = await gateway.permissions();
  if (!can.export) return fail("forbidden", "Недостаточно прав для скачивания шаблона");
  const version = await gateway.getVersionFile(templateId, versionId);
  if (!version) return fail("not_found", "Файл шаблона не найден");
  const url = await gateway.createSignedUrl(version.path, TEMPLATE_SIGNED_URL_TTL_SECONDS, version.filename);
  if (!url) return fail("storage_unavailable", "Не удалось получить ссылку на файл. Проверьте настройку хранилища");
  await gateway.recordDownload(templateId, version.versionNumber);
  return { ok: true, value: url };
}
