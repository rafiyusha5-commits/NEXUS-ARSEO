"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import {
  addDocumentVersion,
  archiveDocument,
  registerDocumentWithFile,
  type OperationDeps,
  type UploadedFile,
} from "@/lib/documents/operations.ts";
import {
  DOCUMENT_STATUSES,
  type DocumentLinkInput,
  type DocumentMetadata,
  isUuid,
  parseLinkValue,
  validateDocumentMetadata,
} from "@/lib/documents/rules.ts";
import { createDocumentGateway, randomHex, sha256Hex } from "@/lib/documents/supabase-gateway.ts";

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function optional(formData: FormData, name: string) {
  return text(formData, name) || null;
}

function withMessage(path: string, kind: "error" | "success", message: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${kind}=${encodeURIComponent(message)}`;
}

function uploadedFile(formData: FormData): UploadedFile | null {
  const value = formData.get("file");
  if (!value || typeof value === "string" || value.size === 0) return null;
  return {
    name: value.name,
    size: value.size,
    type: value.type,
    bytes: async () => new Uint8Array(await value.arrayBuffer()),
  };
}

function readMetadata(formData: FormData): DocumentMetadata {
  const amountText = text(formData, "amount").replace(/\s/g, "").replace(",", ".");
  return {
    document_type_id: text(formData, "document_type_id"),
    title: text(formData, "title"),
    document_number: optional(formData, "document_number"),
    description: optional(formData, "description"),
    document_date: optional(formData, "document_date"),
    valid_until: optional(formData, "valid_until"),
    language: optional(formData, "language"),
    currency_id: optional(formData, "currency_id"),
    amount: amountText ? Number(amountText) : null,
  };
}

const deps: OperationDeps = {
  newDocumentId: () => crypto.randomUUID(),
  randomHex,
  sha256Hex,
};

export async function registerDocumentAction(formData: FormData) {
  const { supabase, user } = await requireUser();
  const requestedReturn = text(formData, "return_to");
  // Only known internal pages: prevents open redirects such as "//evil.example".
  const back = /^\/(documents|shipments\/[0-9a-f-]{36})$/.test(requestedReturn) ? requestedReturn : "/documents";
  const file = uploadedFile(formData);
  if (!file) redirect(withMessage(back, "error", "Выберите файл документа"));

  const links: DocumentLinkInput[] = [];
  for (const [index, field] of ["link_primary", "link_extra_1", "link_extra_2"].entries()) {
    const value = text(formData, field);
    if (!value) continue;
    const link = parseLinkValue(value, index === 0 ? "primary" : "related");
    if (!link) redirect(withMessage(back, "error", "Некорректный связанный объект"));
    if (!links.some((existing) => existing.entity_type === link.entity_type && existing.entity_id === link.entity_id)) {
      links.push(link);
    }
  }

  const gateway = createDocumentGateway(supabase, user.id);
  const result = await registerDocumentWithFile(gateway, deps, readMetadata(formData), links, file);
  if (!result.ok) redirect(withMessage(back, "error", result.error));

  revalidatePath("/documents");
  for (const link of links) {
    if (link.entity_type === "shipment") revalidatePath(`/shipments/${link.entity_id}`);
  }
  const permissions = await gateway.permissions();
  redirect(
    permissions.view
      ? withMessage(`/documents/${result.value}`, "success", "Документ зарегистрирован")
      : withMessage("/documents", "success", "Документ зарегистрирован"),
  );
}

export async function addDocumentVersionAction(formData: FormData) {
  const { supabase, user } = await requireUser();
  const documentId = text(formData, "document_id");
  const back = isUuid(documentId) ? `/documents/${documentId}` : "/documents";
  const file = uploadedFile(formData);
  if (!file) redirect(withMessage(back, "error", "Выберите файл новой версии"));

  const result = await addDocumentVersion(
    createDocumentGateway(supabase, user.id),
    deps,
    documentId,
    file,
    optional(formData, "comment"),
  );
  if (!result.ok) redirect(withMessage(back, "error", result.error));
  revalidatePath(back);
  revalidatePath("/documents");
  redirect(withMessage(back, "success", "Новая версия загружена"));
}

export async function archiveDocumentAction(formData: FormData) {
  const { supabase, user } = await requireUser();
  const documentId = text(formData, "document_id");
  const back = isUuid(documentId) ? `/documents/${documentId}` : "/documents";
  const result = await archiveDocument(createDocumentGateway(supabase, user.id), documentId, text(formData, "reason"));
  if (!result.ok) redirect(withMessage(back, "error", result.error));
  revalidatePath(back);
  revalidatePath("/documents");
  redirect(withMessage(back, "success", "Документ перенесён в архив. Файлы и история сохранены"));
}

export async function updateDocumentAction(formData: FormData) {
  const { supabase } = await requireUser();
  const documentId = text(formData, "document_id");
  if (!isUuid(documentId)) redirect(withMessage("/documents", "error", "Некорректный документ"));
  const back = `/documents/${documentId}`;

  const metadata = readMetadata(formData);
  const status = text(formData, "status");
  const error = validateDocumentMetadata(metadata);
  if (error) redirect(withMessage(back, "error", error));
  if (!(DOCUMENT_STATUSES as readonly string[]).includes(status)) redirect(withMessage(back, "error", "Некорректный статус"));

  const { data, error: updateError } = await supabase
    .from("documents")
    .update({ ...metadata, title: metadata.title.trim(), status })
    .eq("id", documentId)
    .select("id");
  if (updateError) redirect(withMessage(back, "error", updateError.message));
  if (!data?.length) redirect(withMessage(back, "error", "Изменения не сохранены: нет права или документ в архиве"));
  revalidatePath(back);
  revalidatePath("/documents");
  redirect(withMessage(back, "success", "Реквизиты сохранены"));
}

export async function addDocumentLinkAction(formData: FormData) {
  const { supabase } = await requireUser();
  const documentId = text(formData, "document_id");
  if (!isUuid(documentId)) redirect(withMessage("/documents", "error", "Некорректный документ"));
  const back = `/documents/${documentId}`;
  const roleValue = text(formData, "link_role");
  const role = (["primary", "related", "supporting"].includes(roleValue) ? roleValue : "related") as DocumentLinkInput["link_role"];
  const link = parseLinkValue(text(formData, "link"), role);
  if (!link) redirect(withMessage(back, "error", "Выберите объект для связи"));

  const { error } = await supabase.from("document_links").insert({
    document_id: documentId,
    entity_type: link.entity_type,
    entity_id: link.entity_id,
    link_role: link.link_role,
  });
  if (error) {
    const message = error.code === "23505" ? "Документ уже связан с этим объектом" : error.message;
    redirect(withMessage(back, "error", message));
  }
  revalidatePath(back);
  if (link.entity_type === "shipment") revalidatePath(`/shipments/${link.entity_id}`);
  redirect(withMessage(back, "success", "Связь добавлена"));
}

export async function removeDocumentLinkAction(formData: FormData) {
  const { supabase, user } = await requireUser();
  const documentId = text(formData, "document_id");
  const linkId = text(formData, "link_id");
  if (!isUuid(documentId) || !isUuid(linkId)) redirect(withMessage("/documents", "error", "Некорректная связь"));
  const back = `/documents/${documentId}`;

  const { data, error } = await supabase
    .from("document_links")
    .update({ removed_at: new Date().toISOString(), removed_by: user.id })
    .eq("id", linkId)
    .eq("document_id", documentId)
    .is("removed_at", null)
    .select("entity_type, entity_id");
  if (error) redirect(withMessage(back, "error", error.message));
  if (!data?.length) redirect(withMessage(back, "error", "Связь не удалена: нет права или документ в архиве"));
  revalidatePath(back);
  if (data[0].entity_type === "shipment") revalidatePath(`/shipments/${data[0].entity_id}`);
  redirect(withMessage(back, "success", "Связь снята. История сохранена в журнале"));
}
