"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import type { UploadedFile } from "@/lib/documents/operations.ts";
import { randomHex, sha256Hex } from "@/lib/documents/supabase-gateway.ts";
import { addTemplateVersion, registerTemplateWithFile } from "@/lib/templates/operations.ts";
import { type TemplateMetadata, parseTemplateVariables, validateTemplateMetadata, variablesToSchema } from "@/lib/templates/rules.ts";
import { createTemplateGateway } from "@/lib/templates/supabase-gateway.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function withMessage(path: string, kind: "error" | "success", message: string) {
  return `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`;
}

function uploadedFile(formData: FormData): UploadedFile | null {
  const value = formData.get("file");
  if (!value || typeof value === "string" || value.size === 0) return null;
  return { name: value.name, size: value.size, type: value.type, bytes: async () => new Uint8Array(await value.arrayBuffer()) };
}

function readMetadata(formData: FormData, back: string): TemplateMetadata {
  const parsed = parseTemplateVariables(text(formData, "variables"));
  if (!parsed.ok) redirect(withMessage(back, "error", parsed.error));
  return {
    document_type_id: text(formData, "document_type_id"),
    name: text(formData, "name"),
    language: text(formData, "language"),
    purpose: text(formData, "purpose") || null,
    counterparty_id: text(formData, "counterparty_id") || null,
    variables: parsed.variables,
  };
}

function templatePath(formData: FormData) {
  const id = text(formData, "template_id");
  if (!UUID.test(id)) redirect(withMessage("/templates", "error", "Некорректный шаблон"));
  return { id, back: `/templates/${id}` };
}

const deps = { newId: () => crypto.randomUUID(), randomHex, sha256Hex };

export async function createTemplateAction(formData: FormData) {
  const { supabase, user } = await requireUser();
  const file = uploadedFile(formData);
  if (!file) redirect(withMessage("/templates", "error", "Выберите файл шаблона"));
  const result = await registerTemplateWithFile(createTemplateGateway(supabase, user.id), deps, readMetadata(formData, "/templates"), file);
  if (!result.ok) redirect(withMessage("/templates", "error", result.error));
  revalidatePath("/templates");
  redirect(withMessage(`/templates/${result.value}`, "success", "Шаблон создан. Он станет доступен для карт после утверждения"));
}

export async function addTemplateVersionAction(formData: FormData) {
  const { supabase, user } = await requireUser();
  const { id, back } = templatePath(formData);
  const file = uploadedFile(formData);
  if (!file) redirect(withMessage(back, "error", "Выберите файл новой версии"));
  const result = await addTemplateVersion(createTemplateGateway(supabase, user.id), deps, id, file, text(formData, "comment") || null);
  if (!result.ok) redirect(withMessage(back, "error", result.error));
  revalidatePath(back);
  revalidatePath("/templates");
  redirect(withMessage(back, "success", "Новая версия загружена. Шаблон снова требует утверждения"));
}

export async function updateTemplateAction(formData: FormData) {
  const { supabase } = await requireUser();
  const { id, back } = templatePath(formData);
  const metadata = readMetadata(formData, back);
  const error = validateTemplateMetadata(metadata);
  if (error) redirect(withMessage(back, "error", error));
  const { data, error: updateError } = await supabase
    .from("document_templates")
    .update({
      document_type_id: metadata.document_type_id,
      name: metadata.name,
      language: metadata.language,
      purpose: metadata.purpose,
      counterparty_id: metadata.counterparty_id,
      variables_schema: variablesToSchema(metadata.variables),
    })
    .eq("id", id)
    .select("status");
  if (updateError) {
    const message = updateError.code === "23505" ? "Шаблон с таким названием, типом и языком уже есть" : updateError.message;
    redirect(withMessage(back, "error", message));
  }
  if (!data?.length) redirect(withMessage(back, "error", "Изменения не сохранены: нет права или шаблон в архиве"));
  revalidatePath(back);
  revalidatePath("/templates");
  redirect(withMessage(back, "success", data[0].status === "draft" ? "Сохранено. Шаблон — черновик и требует утверждения" : "Сохранено"));
}

async function callTemplateRpc(formData: FormData, rpc: string, args: Record<string, unknown>, success: string) {
  const { supabase } = await requireUser();
  const { id, back } = templatePath(formData);
  const { error } = await supabase.rpc(rpc, { p_template_id: id, ...args });
  if (error) redirect(withMessage(back, "error", error.message));
  revalidatePath(back);
  revalidatePath("/templates");
  redirect(withMessage(back, "success", success));
}

export async function approveTemplateAction(formData: FormData) {
  await callTemplateRpc(formData, "approve_document_template", {}, "Шаблон утверждён");
}

export async function setTemplateActiveAction(formData: FormData) {
  const active = text(formData, "is_active") === "true";
  await callTemplateRpc(formData, "set_document_template_active", { p_is_active: active }, active ? "Шаблон включён" : "Шаблон отключён");
}

export async function archiveTemplateAction(formData: FormData) {
  await callTemplateRpc(formData, "archive_document_template", { p_reason: text(formData, "reason") }, "Шаблон перенесён в архив. Файлы и версии сохранены");
}
