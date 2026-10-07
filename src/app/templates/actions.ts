"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import type { UploadedFile } from "@/lib/documents/operations.ts";
import { randomHex, sha256Hex } from "@/lib/documents/supabase-gateway.ts";
import { addTemplateVersion, registerTemplateWithFile } from "@/lib/templates/operations.ts";
import { type TemplateMetadata, parseTemplateVariables, validateTemplateMetadata, variablesToSchema } from "@/lib/templates/rules.ts";
import { createTemplateGateway } from "@/lib/templates/supabase-gateway.ts";
import { loadTemplatePermissions } from "@/lib/templates/supabase-gateway.ts";
import { loadPermissions } from "@/lib/permissions.ts";
import { loadGenerationPreview } from "@/lib/templates/generation-service.ts";
import { DOCX_MIME, renderDocxTemplate } from "@/lib/templates/generation-docx.ts";
import { XLSX_MIME, renderShipmentWorkbookTemplate } from "@/lib/templates/generation-xlsx.ts";
import { buildExportDocuments, PreflightError } from "@/lib/export-workbook/index.ts";
import { generatedFileName } from "@/lib/templates/generation.ts";
import { DOCUMENT_BUCKET, buildDocumentStoragePath, normalizeFileName } from "@/lib/documents/files.ts";

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
    flow_direction: text(formData, "flow_direction"),
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

// CMR, ТТН and the packing list are the sheets of the filled workbook, issued as XLSX files with the print setup of the reference.
const PACKAGE_OUTPUTS={
 workbook:{code:"shipment_workbook",format:"xlsx",label:"Рабочая книга отгрузки"},
 cmr:{code:"cmr",format:"xlsx",label:"CMR"},
 ttn:{code:"ttn",format:"xlsx",label:"ТТН"},
 packing_list:{code:"packing_list",format:"xlsx",label:"Упаковочный лист"},
} as const;
const exportErrorMessage=(error:unknown,fallback:string)=>error instanceof PreflightError?error.message:publicErrorMessage(error,fallback);

export async function generateExportPackageAction(formData:FormData){
 const templateId=text(formData,"template_id"),shipmentId=text(formData,"shipment_id"),transportId=text(formData,"transport_id");
 const back=UUID.test(templateId)?`/templates/${templateId}/generate?shipment=${encodeURIComponent(shipmentId)}${UUID.test(transportId)?`&transport=${encodeURIComponent(transportId)}`:""}&prices=${text(formData,"include_prices")==="true"?"1":"0"}`:"/templates";
 if(!UUID.test(templateId)||!UUID.test(shipmentId))redirect(withMessage(back,"error","Выберите шаблон и поставку"));
 const selected=[...new Set(formData.getAll("outputs").filter((value):value is string=>typeof value==="string"&&value in PACKAGE_OUTPUTS))] as Array<keyof typeof PACKAGE_OUTPUTS>;
 if(!selected.length)redirect(withMessage(back,"error","Отметьте документы, которые нужно сформировать"));
 const{supabase}=await requireUser();const[can,access]=await Promise.all([loadTemplatePermissions(supabase),loadPermissions(supabase,["documents.create","shipments.view"] as const)]);
 if(!can.generate||!access["documents.create"]||!access["shipments.view"])redirect(withMessage(back,"error","Недостаточно прав для формирования комплекта"));
 const includePrices=text(formData,"include_prices")==="true"&&can.generate_prices;
 let preview;try{preview=await loadGenerationPreview(supabase,templateId,shipmentId,includePrices,UUID.test(transportId)?transportId:undefined);}catch(error){redirect(withMessage(back,"error",publicErrorMessage(error,"Не удалось подготовить данные для документов.")));}
 const manualNumbers={cmr_number:text(formData,"cmr_number"),ttn_number:text(formData,"ttn_number"),packing_list_number:text(formData,"packing_list_number")};
 if(Object.values(manualNumbers).some(value=>value.length>120))redirect(withMessage(back,"error","Номер документа не должен быть длиннее 120 символов"));
 const unresolvedTemplateFields=preview.missing.filter(field=>!(field.key in manualNumbers&&manualNumbers[field.key as keyof typeof manualNumbers]));
 if(unresolvedTemplateFields.length)redirect(withMessage(back,"error",`Не заполнены обязательные поля шаблона: ${unresolvedTemplateFields.map(field=>field.label).join(", ")}`));
 if(!preview.readiness.ready)redirect(withMessage(back,"error",`Комплект не готов: заполните ${preview.readiness.items.filter(item=>item.required&&!item.ready).map(item=>item.label).join(", ")}`));
 const version=preview.template.current as Record<string,unknown>;if(String(version.mime_type)!==XLSX_MIME)redirect(withMessage(back,"error","Экспортный комплект формируется только из утверждённой книги XLSX"));
 const generationData:Record<string,unknown>={...preview.data,...Object.fromEntries(Object.entries(manualNumbers).filter(([,value])=>value))};
 const storage=supabase.storage.from(DOCUMENT_BUCKET);const{data:source,error:downloadError}=await storage.download(String(version.storage_path));
 if(downloadError||!source)redirect(withMessage(back,"error",publicErrorMessage(downloadError,"Файл шаблона не найден.")));
 const shipmentNumber=String(preview.data.shipment_number),transportSuffix=preview.data.selected_transport_sequence?`-авто-${preview.data.selected_transport_sequence}`:"",templateBytes=new Uint8Array(await source.arrayBuffer());
 let built;try{built=buildExportDocuments(templateBytes,generationData,selected,{includePrices});}catch(error){redirect(withMessage(back,"error",exportErrorMessage(error,"Не удалось заполнить книгу экспортной отгрузки.")));}
 const uploadedPaths:string[]=[];const files:Array<Record<string,unknown>>=[];
 try{
  for(const document of built){
   const key=document.output;const config=PACKAGE_OUTPUTS[key];const documentId=crypto.randomUUID(),generationId=crypto.randomUUID();
    const filename=key==="workbook"?generatedFileName(String(version.original_filename),`${shipmentNumber}${transportSuffix}`):`${config.label.replace(/\s+/g,"-")}-${shipmentNumber.replace(/[^A-Za-zА-Яа-я0-9._-]+/g,"-")}${transportSuffix}.xlsx`;
   const bytes=document.bytes;
   const path=buildDocumentStoragePath(documentId,normalizeFileName(filename),randomHex());const contentType=XLSX_MIME;
   const{error:uploadError}=await storage.upload(path,bytes,{contentType,upsert:false,cacheControl:"0"});if(uploadError)throw uploadError;
    uploadedPaths.push(path);files.push({generation_id:generationId,document_id:documentId,document_type_code:config.code,title:`${config.label} · ${shipmentNumber}${transportSuffix?` · Автомобиль №${preview.data.selected_transport_sequence}`:""}`,storage_path:path,original_filename:filename,document_number:String(generationData[`${key}_number`]||shipmentNumber),output_format:config.format,checksum_sha256:await sha256Hex(bytes)});
  }
   const{error}=await supabase.rpc("register_generated_document_package",{p_template_id:templateId,p_template_version_id:String(version.id),p_shipment_id:shipmentId,p_files:files,p_contains_prices:includePrices,p_fields_snapshot:generationData});
  if(error)throw error;
 }catch(error){if(uploadedPaths.length)await storage.remove(uploadedPaths);redirect(withMessage(back,"error",publicErrorMessage(error,"Не удалось сформировать комплект документов.")));}
 revalidatePath("/templates");revalidatePath(`/templates/${templateId}`);revalidatePath("/documents");revalidatePath(`/shipments/${shipmentId}`);
 redirect(`/shipments/${shipmentId}?success=${encodeURIComponent(`Сформирован комплект: ${selected.length} документ(а)`)}`);
}

export async function generateDocumentAction(formData:FormData){
 const templateId=text(formData,"template_id"),shipmentId=text(formData,"shipment_id");
 const back=UUID.test(templateId)?`/templates/${templateId}/generate?shipment=${encodeURIComponent(shipmentId)}`:"/templates";
 if(!UUID.test(templateId)||!UUID.test(shipmentId))redirect(withMessage(back,"error","Выберите шаблон и поставку"));
 const{supabase}=await requireUser();const[can,access]=await Promise.all([loadTemplatePermissions(supabase),loadPermissions(supabase,["documents.create","shipments.view"] as const)]);if(!can.generate)redirect(withMessage(back,"error","Недостаточно прав для формирования документа"));
 if(!access["documents.create"]||!access["shipments.view"])redirect(withMessage(back,"error","Для формирования нужны права на создание документов и просмотр поставок"));
 const includePrices=text(formData,"include_prices")==="true"&&can.generate_prices;
 let preview;try{preview=await loadGenerationPreview(supabase,templateId,shipmentId,includePrices);}catch(error){redirect(withMessage(back,"error",publicErrorMessage(error,"Не удалось подготовить данные для документа.")));}
 if(preview.missing.length)redirect(withMessage(back,"error",`Не заполнены обязательные поля шаблона: ${preview.missing.map(field=>field.label).join(", ")}`));
 if(!preview.readiness.ready)redirect(withMessage(back,"error",`Документ не готов: заполните ${preview.readiness.items.filter(item=>item.required&&!item.ready).map(item=>item.label).join(", ")}`));
 const version=preview.template.current as Record<string,unknown>;const storage=supabase.storage.from(DOCUMENT_BUCKET);
 const{data:source,error:downloadError}=await storage.download(String(version.storage_path));if(downloadError||!source)redirect(withMessage(back,"error",publicErrorMessage(downloadError,"Файл шаблона не найден.")));
 let bytes:Uint8Array;const mime=String(version.mime_type);try{const input=new Uint8Array(await source.arrayBuffer());bytes=mime===XLSX_MIME?renderShipmentWorkbookTemplate(input,preview.data):renderDocxTemplate(input,preview.data);}catch(error){redirect(withMessage(back,"error",exportErrorMessage(error,"Не удалось заполнить шаблон.")));}
 const documentId=crypto.randomUUID(),generationId=crypto.randomUUID();const filename=generatedFileName(String(version.original_filename),String(preview.data.shipment_number));const path=buildDocumentStoragePath(documentId,normalizeFileName(filename),randomHex());
 const outputMime=mime===XLSX_MIME?XLSX_MIME:DOCX_MIME;const{error:uploadError}=await storage.upload(path,bytes,{contentType:outputMime,upsert:false,cacheControl:"0"});if(uploadError)redirect(withMessage(back,"error",publicErrorMessage(uploadError,"Не удалось сохранить сформированный файл.")));
 const checksum=await sha256Hex(bytes);const title=text(formData,"title")||`${preview.template.name} · ${preview.data.shipment_number}`;const number=text(formData,"document_number")||null;
 const{error:registerError}=await supabase.rpc("register_generated_document",{p_generation_id:generationId,p_template_id:templateId,p_template_version_id:String(version.id),p_shipment_id:shipmentId,p_document_id:documentId,p_title:title.slice(0,300),p_storage_path:path,p_original_filename:filename,p_document_number:number,p_document_date:new Date().toISOString().slice(0,10),p_language:preview.template.language,p_checksum_sha256:checksum,p_contains_prices:includePrices,p_fields_snapshot:preview.data});
 if(registerError){await storage.remove([path]);redirect(withMessage(back,"error",publicErrorMessage(registerError,"Не удалось зарегистрировать сформированный документ.")));}
 revalidatePath("/templates");revalidatePath(`/templates/${templateId}`);revalidatePath("/documents");revalidatePath(`/shipments/${shipmentId}`);redirect(`/documents/${documentId}?success=${encodeURIComponent("Документ сформирован из шаблона")}`);
}

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
      flow_direction: metadata.flow_direction,
      purpose: metadata.purpose,
      counterparty_id: metadata.counterparty_id,
      variables_schema: variablesToSchema(metadata.variables),
    })
    .eq("id", id)
    .select("status");
  if (updateError) {
    const message = updateError.code === "23505" ? "Шаблон с таким названием, типом и языком уже есть" : publicErrorMessage(updateError,"Не удалось сохранить шаблон.");
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
  if (error) redirect(withMessage(back, "error", publicErrorMessage(error,"Не удалось выполнить действие с шаблоном.")));
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
