// Server-side document operations. Supabase access is behind DocumentGateway so the
// rules (permission first, validation before upload, cleanup after failures) are
// unit-tested without a database. The database enforces the same rules again via RLS.

import {
  buildDocumentStoragePath,
  checkDocumentFile,
  matchesFileSignature,
  normalizeFileName,
} from "./files.ts";
import {
  type DocumentLinkInput,
  type DocumentMetadata,
  isUuid,
  validateDocumentMetadata,
  validateLinks,
} from "./rules.ts";

export const SIGNED_URL_TTL_SECONDS = 60;

export type DocumentPermissions = {
  view: boolean;
  create: boolean;
  update: boolean;
  approve: boolean;
  archive: boolean;
  manage_types: boolean;
  manage_requirements: boolean;
};

export type StorageFailure = { message: string; statusCode?: string | number | null };

export type DocumentGateway = {
  permissions(): Promise<DocumentPermissions>;
  findDocumentWithChecksum(checksum: string): Promise<{ id: string; title: string } | null>;
  getDocumentState(documentId: string): Promise<{ archived: boolean; checksums: string[] } | null>;
  uploadFile(path: string, bytes: Uint8Array, contentType: string): Promise<StorageFailure | null>;
  removeFile(path: string): Promise<void>;
  registerDocument(input: RegisterDocumentCall): Promise<string | null>;
  insertVersion(input: InsertVersionCall): Promise<string | null>;
  archiveDocument(documentId: string, reason: string): Promise<string | null>;
  getVersionFile(documentId: string, versionId: string | null): Promise<{ path: string; filename: string; versionNumber: number } | null>;
  createSignedUrl(path: string, expiresInSeconds: number, downloadName: string): Promise<string | null>;
  recordDownload(documentId: string, versionNumber: number): Promise<void>;
};

export type RegisterDocumentCall = DocumentMetadata & {
  document_id: string;
  storage_path: string;
  original_filename: string;
  checksum_sha256: string;
  links: DocumentLinkInput[];
};

export type InsertVersionCall = {
  document_id: string;
  storage_path: string;
  original_filename: string;
  checksum_sha256: string;
  comment: string | null;
};

export type UploadedFile = {
  name: string;
  size: number;
  type: string;
  bytes(): Promise<Uint8Array>;
};

export type ErrorCode = "forbidden" | "invalid" | "duplicate" | "not_found" | "archived" | "storage_unavailable" | "failed";
export type OperationResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; error: string };

export type OperationDeps = {
  newDocumentId(): string;
  randomHex(): string;
  sha256Hex(bytes: Uint8Array): Promise<string>;
};

const fail = (code: ErrorCode, error: string): OperationResult<never> => ({ ok: false, code, error });

export const STORAGE_NOT_CONFIGURED_MESSAGE =
  "Хранилище документов не настроено: в Supabase нет приватного bucket «nexus-documents». " +
  "Администратору: примените миграцию 202609271001_document_management.sql или создайте bucket вручную (docs/documents-module.md).";

export function describeStorageFailure(failure: StorageFailure) {
  const status = String(failure.statusCode ?? "");
  const message = failure.message.toLowerCase();
  if (message.includes("bucket not found") || (status === "404" && message.includes("bucket"))) {
    return { code: "storage_unavailable" as const, error: STORAGE_NOT_CONFIGURED_MESSAGE };
  }
  if (status === "403" || message.includes("row-level security") || message.includes("unauthorized")) {
    return { code: "forbidden" as const, error: "Хранилище отклонило загрузку: недостаточно прав" };
  }
  if (status === "409" || message.includes("already exists")) {
    return { code: "duplicate" as const, error: "Файл с таким путём уже существует, повторите загрузку" };
  }
  if (status === "413" || message.includes("maximum allowed size")) {
    return { code: "invalid" as const, error: "Файл превышает допустимый размер" };
  }
  if (message.includes("mime type") || status === "415") {
    return { code: "invalid" as const, error: "Хранилище не принимает этот тип файла" };
  }
  return { code: "failed" as const, error: `Не удалось загрузить файл: ${failure.message}` };
}

async function readCheckedFile(file: UploadedFile) {
  const check = checkDocumentFile(file);
  if (!check.ok) return { error: check.error } as const;
  const bytes = await file.bytes();
  // The reported size is only a hint; the limit is enforced on the bytes received.
  const actual = checkDocumentFile({ name: file.name, size: bytes.byteLength, type: file.type });
  if (!actual.ok) return { error: actual.error } as const;
  if (!matchesFileSignature(check.kind, bytes)) {
    return { error: "Содержимое файла не соответствует его типу" } as const;
  }
  return { bytes, mimeType: check.mimeType } as const;
}

export async function registerDocumentWithFile(
  gateway: DocumentGateway,
  deps: OperationDeps,
  metadata: DocumentMetadata,
  links: DocumentLinkInput[],
  file: UploadedFile,
): Promise<OperationResult<string>> {
  const permissions = await gateway.permissions();
  if (!permissions.create) return fail("forbidden", "Недостаточно прав для регистрации документа");

  const metadataError = validateDocumentMetadata(metadata) ?? validateLinks(links);
  if (metadataError) return fail("invalid", metadataError);

  const checked = await readCheckedFile(file);
  if ("error" in checked) return fail("invalid", checked.error ?? "Некорректный файл");

  const checksum = await deps.sha256Hex(checked.bytes);
  const existing = await gateway.findDocumentWithChecksum(checksum);
  if (existing) {
    return fail("duplicate", `Этот файл уже зарегистрирован: «${existing.title}». Откройте документ и добавьте нужную связь`);
  }

  const documentId = deps.newDocumentId();
  const path = buildDocumentStoragePath(documentId, normalizeFileName(file.name), deps.randomHex());

  const uploadFailure = await gateway.uploadFile(path, checked.bytes, checked.mimeType);
  if (uploadFailure) {
    const described = describeStorageFailure(uploadFailure);
    return fail(described.code, described.error);
  }

  const registerError = await gateway.registerDocument({
    ...metadata,
    title: metadata.title.trim(),
    document_id: documentId,
    storage_path: path,
    original_filename: file.name.slice(0, 255),
    checksum_sha256: checksum,
    links,
  });
  if (registerError) {
    await gateway.removeFile(path);
    return fail("failed", `Документ не зарегистрирован: ${registerError}`);
  }

  return { ok: true, value: documentId };
}

export async function addDocumentVersion(
  gateway: DocumentGateway,
  deps: OperationDeps,
  documentId: string,
  file: UploadedFile,
  comment: string | null,
): Promise<OperationResult<null>> {
  if (!isUuid(documentId)) return fail("invalid", "Некорректный документ");
  const permissions = await gateway.permissions();
  if (!permissions.update) return fail("forbidden", "Недостаточно прав для загрузки новой версии");

  const state = await gateway.getDocumentState(documentId);
  if (!state) return fail("not_found", "Документ не найден");
  if (state.archived) return fail("archived", "Документ в архиве: новые версии запрещены");
  if (comment && comment.length > 1000) return fail("invalid", "Комментарий не должен быть длиннее 1000 символов");

  const checked = await readCheckedFile(file);
  if ("error" in checked) return fail("invalid", checked.error ?? "Некорректный файл");

  const checksum = await deps.sha256Hex(checked.bytes);
  if (state.checksums.includes(checksum)) {
    return fail("duplicate", "Этот файл уже загружен как версия этого документа");
  }

  const path = buildDocumentStoragePath(documentId.toLowerCase(), normalizeFileName(file.name), deps.randomHex());
  const uploadFailure = await gateway.uploadFile(path, checked.bytes, checked.mimeType);
  if (uploadFailure) {
    const described = describeStorageFailure(uploadFailure);
    return fail(described.code, described.error);
  }

  const insertError = await gateway.insertVersion({
    document_id: documentId,
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

export async function archiveDocument(
  gateway: DocumentGateway,
  documentId: string,
  reason: string,
): Promise<OperationResult<null>> {
  if (!isUuid(documentId)) return fail("invalid", "Некорректный документ");
  const permissions = await gateway.permissions();
  if (!permissions.archive) return fail("forbidden", "Недостаточно прав для архивирования документа");
  const trimmed = reason.trim();
  if (trimmed.length < 3) return fail("invalid", "Укажите причину архивирования");
  if (trimmed.length > 500) return fail("invalid", "Причина не должна быть длиннее 500 символов");
  const error = await gateway.archiveDocument(documentId, trimmed);
  if (error) return fail("failed", error);
  return { ok: true, value: null };
}

export async function createDocumentDownloadUrl(
  gateway: DocumentGateway,
  documentId: string,
  versionId: string | null,
): Promise<OperationResult<string>> {
  if (!isUuid(documentId) || (versionId !== null && !isUuid(versionId))) return fail("invalid", "Некорректная ссылка");
  const permissions = await gateway.permissions();
  if (!permissions.view) return fail("forbidden", "Недостаточно прав для просмотра документа");
  const version = await gateway.getVersionFile(documentId, versionId);
  if (!version) return fail("not_found", "Файл документа не найден");
  const url = await gateway.createSignedUrl(version.path, SIGNED_URL_TTL_SECONDS, version.filename);
  if (!url) return fail("storage_unavailable", "Не удалось получить ссылку на файл. Проверьте настройку хранилища");
  await gateway.recordDownload(documentId, version.versionNumber);
  return { ok: true, value: url };
}
