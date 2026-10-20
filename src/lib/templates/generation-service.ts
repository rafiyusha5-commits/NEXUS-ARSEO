import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { schemaToVariables } from "./rules.ts";
import { missingGenerationFields } from "./generation.ts";
import { assembleGenerationData, type SourceRow } from "./generation-assembly.ts";
import { buildShipmentDocumentReadiness } from "./readiness.ts";
import { buildExportModel, preflightExport, type ExportOutput } from "../export-workbook/index.ts";
import { selectGenerationScope } from "./generation-scope.ts";
import { usableSourceContext, type ContextSource } from "../document-extraction/source-context.ts";

const XLSX_MIME_TYPE="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXPORT_OUTPUTS:ExportOutput[]=["workbook","cmr","ttn","packing_list"];

const one=<T,>(value:T|T[]|null|undefined):T|undefined=>Array.isArray(value)?value[0]:value??undefined;

export async function loadGenerationPreview(supabase:SupabaseClient,templateId:string,shipmentId:string,includePrices:boolean,transportId?:string){
 const [{data:template,error:templateError},{data:shipment,error:shipmentError},{data:items,error:itemsError},{data:transports,error:transportError},{data:sourceExtractions,error:sourceError,count:sourceCount}]=await Promise.all([
  supabase.from("document_templates").select("id,name,language,flow_direction,counterparty_id,document_type_id,status,is_active,variables_schema,current:document_template_versions(id,storage_path,original_filename,mime_type,version_number,is_current)").eq("id",templateId).eq("current.is_current",true).maybeSingle(),
  supabase.from("shipments").select("id,shipment_number,project_code,type,status,incoterms,planned_ready_date,planned_arrival_date,supplier_id,customer_id,route_id,contract_id,currency_id,destination_warehouse_id,responsible_user_id,supplier:counterparties!shipments_supplier_id_fkey(legal_name,short_name,tax_id,country),customer:counterparties!shipments_customer_id_fkey(legal_name,short_name,tax_id,country),route:routes(name),warehouse:warehouses!shipments_destination_warehouse_id_fkey(name,address),responsible:profiles!shipments_responsible_user_id_fkey(full_name),currency:currencies(code),contract:contracts(number)").eq("id",shipmentId).maybeSingle(),
   supabase.from("shipment_items").select("id,shipment_transport_id,product_id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,currency:currencies(code)").eq("shipment_id",shipmentId).order("created_at"),
  supabase.from("shipment_transports").select("id,sequence_no,driver_name,driver_phone,driver_document,vehicle_plate,vehicle_make,trailer_plate,trailer_make,carrier_name,temperature_setpoint,planned_loading_date,actual_loading_date,planned_arrival_date,actual_arrival_date,carrier:carriers(counterparty:counterparties(legal_name,short_name)),vehicle:vehicles(plate_number,trailer_plate_number)").eq("shipment_id",shipmentId).neq("status","cancelled").order("sequence_no"),
  supabase.from("shipment_source_extractions").select("confirmed_data,extracted_data,shipment_transport_id,reviewed_at,status,document_version_id,document:documents(archived_at,status,current_version,versions:document_versions!document_versions_document_id_fkey(id,is_current,version_number),links:document_links(entity_type,entity_id,removed_at))",{count:"exact"}).eq("shipment_id",shipmentId).eq("status","confirmed").order("reviewed_at"),
 ]);
 const firstError=templateError||shipmentError||itemsError||transportError;if(firstError)throw new Error(firstError.message);
 if(!template)throw new Error("Шаблон не найден");if(!shipment)throw new Error("Поставка не найдена");
 const current=one(template.current as unknown as Array<Record<string,unknown>>);if(!current)throw new Error("У шаблона нет текущей версии");
 if(template.status!=="approved"||!template.is_active)throw new Error("Для формирования нужен включённый утверждённый шаблон");
 if(!["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(String(current.mime_type)))throw new Error("Автоматическое формирование поддерживает шаблоны DOCX и XLSX");
 if(template.counterparty_id&&((template.flow_direction==="input"&&template.counterparty_id!==shipment.supplier_id)||(template.flow_direction==="output"&&template.counterparty_id!==shipment.customer_id)))throw new Error("Шаблон предназначен для другого контрагента");
 const{selectedItems}=selectGenerationScope(items??[],transports??[],transportId);
 const productIds=[...new Set(selectedItems.map(item=>item.product_id as string))];
 const productResults=productIds.length?await Promise.all([
  supabase.from("products").select("id,internal_sku,name,brand,hs_code,country_of_origin").in("id",productIds),
  supabase.from("product_identifiers").select("product_id,identifier_type,value,counterparty_id,is_primary").in("product_id",productIds).order("is_primary",{ascending:false}),
  supabase.from("product_packaging").select("product_id,uom,units_per_parent,gross_weight_kg,net_weight_kg").in("product_id",productIds),
 ]):[{data:[]},{data:[]},{data:[]}];
 const productError=productResults.map(result=>("error" in result?result.error:null)).find(Boolean);if(productError)throw new Error(productError.message);
 const [{data:products},{data:identifiers},{data:packaging}]=productResults;
 const {data:priceRows,error:priceError}=includePrices?await supabase.rpc("my_shipment_item_purchase_prices",{p_shipment_id:shipmentId}):{data:[],error:null};
 if(priceError)throw new Error(priceError.message);
 const priceByItem=new Map<string,unknown>((priceRows??[]).map((row:{item_id:string;unit_price:number|string|null})=>[row.item_id,row.unit_price]));
 // The data of one vehicle's set is assembled by a pure function (tested for isolation between vehicles).
 if(sourceError || sourceCount === null || sourceCount !== sourceExtractions?.length) throw new Error("Источники комплекта загружены не полностью. Повторите проверку");
 const usableSources = (sourceExtractions as unknown as Array<SourceRow & ContextSource>).filter(row => usableSourceContext(row,shipmentId,(transports??[]).map(t=>t.id)));
 const{data,confirmedSourceFields}=assembleGenerationData({shipment:shipment as Record<string,unknown>,items:(items??[]) as Array<Record<string,unknown>>,transports:(transports??[]) as Array<Record<string,unknown>>,transportId,products:(products??[]) as Array<Record<string,unknown>>,identifiers:(identifiers??[]) as Array<Record<string,unknown>>,packaging:(packaging??[]) as Array<Record<string,unknown>>,priceByItem,includePrices,sources:usableSources});
 const variables=schemaToVariables(template.variables_schema);
 const exportModel=String(current.mime_type)===XLSX_MIME_TYPE?buildExportModel(data):null;
 const exportReadiness=exportModel?EXPORT_OUTPUTS.map(output=>({output,...preflightExport(exportModel,[output],{includePrices})})):[];
 return{template:{...template,current},shipment,data,variables,missing:missingGenerationFields(variables,data),containsPrices:includePrices,confirmedSourceFields,readiness:buildShipmentDocumentReadiness(data,confirmedSourceFields),exportReadiness};
}
