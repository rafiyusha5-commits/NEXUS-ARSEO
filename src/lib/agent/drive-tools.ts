import { DRIVE_PERMISSIONS, DRIVE_ID } from "../google/drive-readonly.ts";
import { CONTENT_STATUS,catalogExcerpt,catalogExpiry } from "../google/catalog-text.ts";
import { maskDataText,maskOutgoing } from "./masking.ts";
import type { AgentTool } from "./types.ts";
export const DRIVE_TOOLS: AgentTool[] = [{
  name: "find_drive_documents", description: "Найти документы в каталоге Nexus по названию, бренду и доступному извлечённому тексту. Декларация соответствия = ДС. Для Belgian используй query='Belgian ДС'. Затем get_drive_document читает текст выбранного файла. Если каталог ещё не создан, доступен поиск названий непосредственно в Google Drive.",
  permissions: DRIVE_PERMISSIONS, params: { query: { type: "string", maxLength: 120, description: "Название документа и бренд, например Belgian ДС" }, offset: { type: "integer", min: 0, max: 1000, optional: true, description: "Смещение следующей страницы" } },
  fields: [{ key: "file_name", label: "Документ", kind: "text" }, { key: "folder_path", label: "Папка", kind: "text" },{key:"source_modified_at",label:"Версия источника",kind:"datetime"}], maxRows: 20, timeoutMs: 30000,
  async run(ctx, params) {
    if (!ctx.data.findDriveDocuments) throw new Error("DRIVE_NOT_CONFIGURED");
    const result = await ctx.data.findDriveDocuments(String(params.query), Number(params.offset ?? 0), ctx.signal);
    return { rows: result.files.map(file => ({ subject: maskDataText(file.name, 160) ?? "Документ", values: { file_name: maskDataText(file.name, 160), folder_path: maskDataText(file.path, 300),source_modified_at:file.modifiedTime??null }, entity: { type: "drive", id: file.id } })), total: result.total, truncated: result.truncated,
      notes: ["Поиск документов. Для ответа по содержимому отдельно прочитайте get_drive_document. Файл с названием Макет или Черновик не является подтверждённым оригиналом."] };
  },
},{
 name:"get_drive_document",description:"Прочитать извлечённый текст конкретного документа из каталога Nexus. Проверяется текущая версия файла в Google Drive. Без текстового слоя возвращается честный статус OCR; текст не придумывается. drive_id берётся из find_drive_documents. Для срока действия выбирай expiry_date только если оно заполнено, иначе document_excerpt с буквальным фрагментом документа.",
 permissions:[...DRIVE_PERMISSIONS,"documents.drive.text.view","prices.purchase.view"],params:{drive_id:{type:"string",maxLength:120,pattern:DRIVE_ID,description:"ID файла из результата поиска"},query:{type:"string",maxLength:120,optional:true,description:"Какая информация нужна: срок действия, состав, товары"}},
 fields:[{key:"file_name",label:"Документ",kind:"text"},{key:"content_status",label:"Текст документа",kind:"status"},{key:"source_modified_at",label:"Версия источника",kind:"datetime"},{key:"indexed_at",label:"Текст прочитан",kind:"datetime"},{key:"document_excerpt",label:"Фрагмент документа",kind:"financial"},{key:"expiry_date",label:"Срок действия до",kind:"date"}],maxRows:1,timeoutMs:10000,
 async run(ctx,params) {
  if(!ctx.data.getDriveDocument)throw new Error("DRIVE_NOT_CONFIGURED");
  const record=await ctx.data.getDriveDocument(String(params.drive_id),ctx.signal);
  if(!record)return {rows:[],total:0,truncated:false,notes:["Документ недоступен или его версия изменилась. Обновите каталог."]};
  const values:Record<string,string|number|null>={file_name:maskDataText(record.file.name,160),content_status:CONTENT_STATUS[record.file.contentStatus??"pending"]??"Текст недоступен",source_modified_at:record.file.modifiedTime??null,indexed_at:record.file.indexedAt??null};
  if(record.text){const safeText=maskOutgoing(record.text);values.document_excerpt=catalogExcerpt(safeText,String(params.query??""));values.expiry_date=catalogExpiry(safeText);}
  const draft=/макет|черновик|draft/iu.test(record.file.name);
  if(draft)delete values.expiry_date;
  return {rows:[{subject:maskDataText(record.file.name,160)??"Документ",values,entity:{type:"drive",id:record.file.id}}],total:1,truncated:false,notes:[...(record.truncated?["Извлечённый текст ограничен по длине; фрагмент не заменяет полный документ."]:[]),...(draft?["Это макет или черновик, не используйте его как действующую декларацию."]:[]),...(!record.text?["Текст не прочитан. Нельзя утверждать содержание или срок действия по названию."]:[])]};
 },
}];
