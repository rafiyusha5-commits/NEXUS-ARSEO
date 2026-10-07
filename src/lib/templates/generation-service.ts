import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { schemaToVariables } from "./rules.ts";
import { buildShipmentGenerationData,missingGenerationFields } from "./generation.ts";
import { mergeConfirmedSourceData } from "@/lib/document-extraction/rules.ts";
import { buildShipmentDocumentReadiness } from "./readiness.ts";

const one=<T,>(value:T|T[]|null|undefined):T|undefined=>Array.isArray(value)?value[0]:value??undefined;

export async function loadGenerationPreview(supabase:SupabaseClient,templateId:string,shipmentId:string,includePrices:boolean){
 const [{data:template,error:templateError},{data:shipment,error:shipmentError},{data:items,error:itemsError},{data:transports,error:transportError},{data:sourceExtractions,error:sourceError}]=await Promise.all([
  supabase.from("document_templates").select("id,name,language,flow_direction,counterparty_id,document_type_id,status,is_active,variables_schema,current:document_template_versions(id,storage_path,original_filename,mime_type,version_number,is_current)").eq("id",templateId).eq("current.is_current",true).maybeSingle(),
  supabase.from("shipments").select("id,shipment_number,project_code,type,status,incoterms,planned_ready_date,planned_arrival_date,supplier_id,customer_id,route_id,contract_id,currency_id,destination_warehouse_id,responsible_user_id,supplier:counterparties!shipments_supplier_id_fkey(legal_name,short_name,tax_id,country),customer:counterparties!shipments_customer_id_fkey(legal_name,short_name,tax_id,country),route:routes(name),warehouse:warehouses!shipments_destination_warehouse_id_fkey(name,address),responsible:profiles!shipments_responsible_user_id_fkey(full_name),currency:currencies(code),contract:contracts(number)").eq("id",shipmentId).maybeSingle(),
  supabase.from("shipment_items").select("id,product_id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,currency:currencies(code)").eq("shipment_id",shipmentId).order("created_at"),
  supabase.from("shipment_transports").select("id,sequence_no,driver_name,driver_phone,temperature_setpoint,planned_loading_date,actual_loading_date,planned_arrival_date,actual_arrival_date,carrier:carriers(counterparty:counterparties(legal_name,short_name)),vehicle:vehicles(plate_number,trailer_plate_number)").eq("shipment_id",shipmentId).neq("status","cancelled").order("sequence_no"),
  supabase.from("shipment_source_extractions").select("confirmed_data,reviewed_at").eq("shipment_id",shipmentId).eq("status","confirmed").order("reviewed_at"),
 ]);
 const firstError=templateError||shipmentError||itemsError||transportError;if(firstError)throw new Error(firstError.message);
 if(!template)throw new Error("Шаблон не найден");if(!shipment)throw new Error("Поставка не найдена");
 const current=one(template.current as unknown as Array<Record<string,unknown>>);if(!current)throw new Error("У шаблона нет текущей версии");
 if(template.status!=="approved"||!template.is_active)throw new Error("Для формирования нужен включённый утверждённый шаблон");
 if(!["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(String(current.mime_type)))throw new Error("Автоматическое формирование поддерживает шаблоны DOCX и XLSX");
 if(template.counterparty_id&&((template.flow_direction==="input"&&template.counterparty_id!==shipment.supplier_id)||(template.flow_direction==="output"&&template.counterparty_id!==shipment.customer_id)))throw new Error("Шаблон предназначен для другого контрагента");
 const productIds=[...new Set((items??[]).map(item=>item.product_id as string))];
 const productResults=productIds.length?await Promise.all([
  supabase.from("products").select("id,internal_sku,name,brand,hs_code,country_of_origin").in("id",productIds),
  supabase.from("product_identifiers").select("product_id,identifier_type,value,counterparty_id,is_primary").in("product_id",productIds).order("is_primary",{ascending:false}),
  supabase.from("product_packaging").select("product_id,uom,units_per_parent,gross_weight_kg,net_weight_kg").in("product_id",productIds),
 ]):[{data:[]},{data:[]},{data:[]}];
 const productError=productResults.map(result=>("error" in result?result.error:null)).find(Boolean);if(productError)throw new Error(productError.message);
 const [{data:products},{data:identifiers},{data:packaging}]=productResults;
 const productMap=new Map((products??[]).map(product=>[product.id as string,product as Record<string,unknown>]));
 const {data:priceRows,error:priceError}=includePrices?await supabase.rpc("my_shipment_item_purchase_prices",{p_shipment_id:shipmentId}):{data:[],error:null};
 if(priceError)throw new Error(priceError.message);
 const priceByItem=new Map((priceRows??[]).map((row:{item_id:string;unit_price:number|string|null})=>[row.item_id,row.unit_price]));
 const normalizedItems=(items??[]).map(item=>({...item,unit_price:includePrices?priceByItem.get(item.id)??null:null,currency_code:one(item.currency as unknown as Array<{code:string}>)?.code}));
 const normalizedTransports=(transports??[]).map(transport=>{const carrier=one(transport.carrier as unknown as Array<Record<string,unknown>>);return{...transport,carrier:carrier?{...carrier,counterparty:one(carrier.counterparty as Array<Record<string,unknown>>)}:undefined,vehicle:one(transport.vehicle as unknown as Array<Record<string,unknown>>)};});
 const baseData=buildShipmentGenerationData({shipment:shipment as Record<string,unknown>,supplier:one(shipment.supplier as unknown as Array<Record<string,unknown>>),customer:one(shipment.customer as unknown as Array<Record<string,unknown>>),route:one(shipment.route as unknown as Array<Record<string,unknown>>),warehouse:one(shipment.warehouse as unknown as Array<Record<string,unknown>>),responsible:one(shipment.responsible as unknown as Array<Record<string,unknown>>),currency:one(shipment.currency as unknown as Array<Record<string,unknown>>),contract:one(shipment.contract as unknown as Array<Record<string,unknown>>),items:normalizedItems as Array<Record<string,unknown>>,products:productMap,identifiers:(identifiers??[]) as Array<Record<string,unknown>>,packaging:(packaging??[]) as Array<Record<string,unknown>>,transports:normalizedTransports as Array<Record<string,unknown>>,includePrices});
 const confirmedSources=(sourceExtractions??[]).map(row=>(row.confirmed_data??{}) as Record<string,unknown>);
 const data=sourceError?baseData:mergeConfirmedSourceData(baseData,confirmedSources);
 const confirmedSourceFields=sourceError?[]:[...new Set(confirmedSources.flatMap(source=>Object.keys(source)))];
 const variables=schemaToVariables(template.variables_schema);
 return{template:{...template,current},shipment,data,variables,missing:missingGenerationFields(variables,data),containsPrices:includePrices,confirmedSourceFields,readiness:buildShipmentDocumentReadiness(data,confirmedSourceFields)};
}
