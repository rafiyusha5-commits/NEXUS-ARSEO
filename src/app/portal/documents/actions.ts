"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePortalUser } from "@/lib/auth/access";
import { buildDocumentStoragePath, checkDocumentFile, DOCUMENT_BUCKET, matchesFileSignature, normalizeFileName } from "@/lib/documents/files.ts";
import { isUuid } from "@/lib/documents/rules.ts";
import { randomHex, sha256Hex } from "@/lib/documents/supabase-gateway.ts";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const back = (kind: "error" | "success", message: string) => `/portal/documents?${kind}=${encodeURIComponent(message)}`;

export async function uploadPortalDocument(formData: FormData) {
  const { supabase } = await requirePortalUser();
  const file = formData.get("file");
  const typeId = value(formData, "document_type_id");
  const title = value(formData, "title");
  if (!(file instanceof File) || !file.size) redirect(back("error", "Выберите файл"));
  if (!isUuid(typeId) || !title || title.length > 300) redirect(back("error", "Проверьте тип и название документа"));
  const check = checkDocumentFile(file);
  if (!check.ok) redirect(back("error", check.error));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!matchesFileSignature(check.kind, bytes)) redirect(back("error", "Содержимое файла не соответствует его типу"));
  const id = crypto.randomUUID();
  const path = buildDocumentStoragePath(id, normalizeFileName(file.name), randomHex());
  const { error: uploadError } = await supabase.storage.from(DOCUMENT_BUCKET).upload(path, bytes, { contentType: check.mimeType, upsert: false });
  if (uploadError) redirect(back("error", uploadError.message));
  const { error } = await supabase.rpc("register_external_document", {
    p_document_id: id,
    p_document_type_id: typeId,
    p_title: title,
    p_storage_path: path,
    p_original_filename: file.name,
    p_document_number: value(formData, "document_number") || null,
    p_description: value(formData, "description") || null,
    p_document_date: value(formData, "document_date") || null,
    p_language: value(formData, "language") || null,
    p_checksum_sha256: await sha256Hex(bytes),
  });
  if (error) {
    await supabase.storage.from(DOCUMENT_BUCKET).remove([path]);
    redirect(back("error", error.message));
  }
  revalidatePath("/portal/documents");
  redirect(back("success", "Документ загружен"));
}
