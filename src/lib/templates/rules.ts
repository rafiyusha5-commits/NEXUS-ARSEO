// Pure rules for document templates. No Next.js or Supabase imports (unit-tested).

import { normalizeFileName } from "../documents/files.ts";

export const TEMPLATE_LANGUAGES = ["ru", "kk", "en"] as const;
export const TEMPLATE_STATUSES = ["draft", "approved", "archived"] as const;
export const TEMPLATE_DIRECTIONS = ["input", "output"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const templateStatusLabel: Record<string, string> = {
  draft: "Черновик",
  approved: "Утверждён",
  archived: "В архиве",
};

export const templateLanguageLabel: Record<string, string> = {
  ru: "Русский",
  kk: "Казахский",
  en: "Английский",
};

export const templateDirectionLabel: Record<string, string> = {
  input: "Ввод от поставщика",
  output: "Вывод для покупателя",
};

export type TemplateVariable = { key: string; label: string };
export type TemplateMetadata = {
  document_type_id: string;
  name: string;
  language: string;
  flow_direction: string;
  purpose: string | null;
  counterparty_id: string | null;
  variables: TemplateVariable[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIABLE_KEY = /^[a-z][a-z0-9_]{0,49}$/;
const RANDOM_HEX = /^[0-9a-f]{32}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TEMPLATE_PATH =
  /^templates\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export const MAX_TEMPLATE_VARIABLES = 100;

// Parses the "fields for substitution" textarea: one field per line, "key — label"
// (also "key: label" or just "key"). Returns an error message for the first bad line.
export function parseTemplateVariables(text: string): { ok: true; variables: TemplateVariable[] } | { ok: false; error: string } {
  const variables: TemplateVariable[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = /^([^\s:—–-]+)\s*(?:[:—–-]\s*(.*))?$/.exec(line);
    const key = match?.[1]?.toLowerCase() ?? "";
    if (!VARIABLE_KEY.test(key)) {
      return { ok: false, error: `Строка ${index + 1}: ключ поля — латиница, цифры и «_», начинается с буквы` };
    }
    if (seen.has(key)) return { ok: false, error: `Поле «${key}» указано дважды` };
    seen.add(key);
    const label = (match?.[2] ?? "").trim().slice(0, 200);
    variables.push({ key, label: label || key });
  }
  if (variables.length > MAX_TEMPLATE_VARIABLES) {
    return { ok: false, error: `Не более ${MAX_TEMPLATE_VARIABLES} полей` };
  }
  return { ok: true, variables };
}

export function variablesToSchema(variables: TemplateVariable[]) {
  return { fields: variables };
}

export function schemaToVariables(schema: unknown): TemplateVariable[] {
  if (!schema || typeof schema !== "object") return [];
  const fields = (schema as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((field): field is TemplateVariable =>
      Boolean(field) && typeof field === "object" && typeof (field as TemplateVariable).key === "string")
    .map((field) => ({ key: field.key, label: typeof field.label === "string" ? field.label : field.key }));
}

export function variablesToText(variables: TemplateVariable[]) {
  return variables.map((variable) => (variable.label && variable.label !== variable.key ? `${variable.key} — ${variable.label}` : variable.key)).join("\n");
}

export function validateTemplateMetadata(metadata: TemplateMetadata): string | null {
  if (!UUID.test(metadata.document_type_id)) return "Выберите тип документа";
  const name = metadata.name.trim();
  if (!name) return "Укажите название шаблона";
  if (name.length > 200) return "Название не должно быть длиннее 200 символов";
  if (!(TEMPLATE_LANGUAGES as readonly string[]).includes(metadata.language)) return "Выберите язык шаблона";
  if (!(TEMPLATE_DIRECTIONS as readonly string[]).includes(metadata.flow_direction)) return "Выберите направление шаблона";
  if (metadata.purpose && metadata.purpose.length > 1000) return "Назначение не должно быть длиннее 1000 символов";
  if (metadata.counterparty_id && !UUID.test(metadata.counterparty_id)) return "Некорректный контрагент";
  if (metadata.variables.length > MAX_TEMPLATE_VARIABLES) return `Не более ${MAX_TEMPLATE_VARIABLES} полей`;
  return null;
}

// Mirrors private.guard_document_template_update(): which metadata changes drop an
// approval. Used to warn the user before saving.
export function editResetsApproval(
  status: string,
  before: { document_type_id: string; language: string; flow_direction: string; counterparty_id: string | null; variables: TemplateVariable[] },
  after: { document_type_id: string; language: string; flow_direction: string; counterparty_id: string | null; variables: TemplateVariable[] },
) {
  if (status !== "approved") return false;
  return (
    before.document_type_id !== after.document_type_id ||
    before.language !== after.language ||
    before.flow_direction !== after.flow_direction ||
    before.counterparty_id !== after.counterparty_id ||
    JSON.stringify(before.variables) !== JSON.stringify(after.variables)
  );
}

export type TemplateAction = "upload" | "edit" | "approve" | "activate" | "deactivate" | "archive" | "download";

// Actions offered for a template, given its state and the user's permissions.
export function availableTemplateActions(
  template: { status: string; is_active: boolean; current_version: number },
  can: { update: boolean; upload: boolean; approve: boolean; change_status: boolean; archive: boolean; export: boolean },
): TemplateAction[] {
  if (template.status === "archived") return can.export && template.current_version > 0 ? ["download"] : [];
  const actions: TemplateAction[] = [];
  if (can.export && template.current_version > 0) actions.push("download");
  if (can.upload) actions.push("upload");
  if (can.update) actions.push("edit");
  if (can.approve && template.status === "draft" && template.current_version > 0) actions.push("approve");
  if (can.change_status) actions.push(template.is_active ? "deactivate" : "activate");
  if (can.archive) actions.push("archive");
  return actions;
}

export function buildTemplateStoragePath(templateId: string, originalName: string, randomHex: string) {
  if (!UUID.test(templateId) || templateId !== templateId.toLowerCase()) throw new Error("Некорректный идентификатор шаблона");
  if (!RANDOM_HEX.test(randomHex)) throw new Error("Некорректная случайная часть пути");
  const safeName = normalizeFileName(originalName);
  if (!SAFE_NAME.test(safeName)) throw new Error("Некорректное имя файла");
  return `templates/${templateId}/${randomHex}-${safeName}`;
}

export function isTemplateStoragePath(path: string, templateId?: string) {
  const match = TEMPLATE_PATH.exec(path);
  if (!match) return false;
  return templateId === undefined || match[1] === templateId;
}
