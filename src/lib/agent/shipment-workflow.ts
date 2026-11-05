import { folderId } from "../google/shipment-folder.ts";
import { isUuid } from "../documents/rules.ts";

/** Navigation only. Never an instruction to import, review or post. */
export function preparationRequest(question: string): { href: string; folder: string | null } | null {
  if (question.length > 1000 || !/подготов|разбер|разоб|загруз|подключ|привяж|привяз|оформ|созда|импортир/iu.test(question)
    || !/поставк|папк/iu.test(question)) return null;
  if (/(?:оформ|подготов)[\p{L}]*\s+(?:при[её]м|продаж|отгруз|заказ|резерв|перемещ)/iu.test(question)) return null;
  if (!/папк|документ|drive|диск/iu.test(question) && !/созда[\p{L}]*\s+(?:новую\s+)?поставк/iu.test(question)) return null;
  const urls = question.match(/https?:\/\/[^\s<>"'\])]+/giu) ?? [];
  const folders = new Set<string>();
  for (const url of urls) { try { folders.add(folderId(url)); } catch { /* Never fetch user-supplied URLs here. */ } }
  // Multiple folders require a human selection; no first-match import.
  const folder = folders.size === 1 ? [...folders][0] : null;
  return { href: `/assistant/shipments${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`, folder };
}

export function folderHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return folderId(value); } catch { return null; }
}

export function workspacePath(id: string, step: "files" | "review" | "operations" = "files"): string {
  if (!isUuid(id)) throw new Error("Некорректная поставка");
  return `/assistant/shipments/${id}?step=${step}`;
}

/** A closed return destination: a form cannot supply an arbitrary redirect URL. */
export function documentActionReturn(form: FormData, id: string, kind: "success" | "error", message: string, source: boolean | "check" = false): string {
  if (!isUuid(id)) return "/shipments";
  const workflow = form.get("assistant_workflow") === "1";
  const base = workflow ? workspacePath(id, source ? "review" : "files") : `/shipments/${id}?tab=documents`;
  const prefix = source === "check" ? "check_" : source ? "source_" : "";
  const anchor = source === "check" ? "document-check" : source ? "source-documents" : "drive-folder";
  return `${base}&${prefix}${kind}=${encodeURIComponent(message)}#${anchor}`;
}

export function createReturn(form: FormData, id: string): string {
  const folder = folderHint(form.get("folder"));
  return `${workspacePath(id)}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
}
