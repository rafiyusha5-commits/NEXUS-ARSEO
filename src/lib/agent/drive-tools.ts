import { DRIVE_PERMISSIONS } from "../google/drive-readonly.ts";
import { maskDataText } from "./masking.ts";
import type { AgentTool } from "./types.ts";
export const DRIVE_TOOLS: AgentTool[] = [{
  name: "find_drive_documents", description: "Найти документы в архиве Google Drive и его вложенных папках по названию и бренду. Декларация соответствия = ДС. Возвращает только названия и путь, не содержимое и не срок действия. Для Belgian используй query='Belgian ДС'.",
  permissions: DRIVE_PERMISSIONS, params: { query: { type: "string", maxLength: 120, description: "Название документа и бренд, например Belgian ДС" }, offset: { type: "integer", min: 0, max: 1000, optional: true, description: "Смещение следующей страницы" } },
  fields: [{ key: "file_name", label: "Документ", kind: "text" }, { key: "folder_path", label: "Папка", kind: "text" }], maxRows: 20, timeoutMs: 30000,
  async run(ctx, params) {
    if (!ctx.data.findDriveDocuments) throw new Error("DRIVE_NOT_CONFIGURED");
    const result = await ctx.data.findDriveDocuments(String(params.query), Number(params.offset ?? 0), ctx.signal);
    return { rows: result.files.map(file => ({ subject: maskDataText(file.name, 160) ?? "Документ", values: { file_name: maskDataText(file.name, 160), folder_path: maskDataText(file.path, 300) }, entity: { type: "drive", id: file.id } })), total: result.total, truncated: result.truncated,
      notes: ["Поиск по названиям в архиве Google Drive. Содержимое и срок действия документа не проверялись."] };
  },
}];
