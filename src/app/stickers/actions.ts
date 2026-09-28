"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(d:FormData,k:string){const v=d.get(k);return typeof v==="string"?v.trim():"";}
function uuid(d:FormData,k:string,required=true){const v=text(d,k);if(!v&&!required)return null;if(!UUID.test(v))throw new Error(`Некорректное поле: ${k}`);return v;}
function num(d:FormData,k:string){const v=Number(text(d,k));if(!Number.isFinite(v))throw new Error(`Некорректное число: ${k}`);return v;}
function content(d:FormData){const raw=text(d,"content");if(!raw)return {};try{const parsed=JSON.parse(raw);if(!parsed||Array.isArray(parsed)||typeof parsed!=="object")throw new Error();return parsed;}catch{throw new Error("Поля макета должны быть корректным JSON-объектом");}}
function go(message:string,kind:"success"|"error"="success"){redirect(`/stickers?${kind}=${encodeURIComponent(message)}`);}
async function run(name:string,args:Record<string,unknown>,success:string){const {supabase}=await requireUser();const {error}=await supabase.rpc(name,args);if(error)go(error.message,"error");revalidatePath("/stickers");go(success);}

export async function createStickerTemplate(d:FormData){
 const languages=d.getAll("languages").filter((v):v is string=>typeof v==="string");
 await run("create_sticker_template",{p_name:text(d,"name"),p_product_id:uuid(d,"product_id",false),p_customer_id:uuid(d,"customer_id",false),p_sticker_level:text(d,"sticker_level"),p_languages:languages,p_content:content(d),p_layout_document_id:uuid(d,"layout_document_id")},"Макет создан как версия 1. Отправьте его на согласование.");
}
export async function addStickerVersion(d:FormData){await run("add_sticker_template_version",{p_template_id:uuid(d,"template_id"),p_content:content(d),p_layout_document_id:uuid(d,"layout_document_id")},"Новая версия макета создана");}
export async function submitStickerVersion(d:FormData){await run("submit_sticker_template_version",{p_version_id:uuid(d,"version_id")},"Версия отправлена на согласование");}
export async function decideStickerVersion(d:FormData){await run("decide_sticker_template_version",{p_version_id:uuid(d,"version_id"),p_approved:text(d,"decision")==="approve",p_comment:text(d,"comment")||null},text(d,"decision")==="approve"?"Версия утверждена":"Версия отклонена");}
export async function createStickerOrder(d:FormData){await run("create_sticker_order",{p_shipment_id:uuid(d,"shipment_id"),p_printing_house_id:uuid(d,"printing_house_id",false),p_reserve_pct:num(d,"reserve_pct"),p_minimum_print_run:num(d,"minimum_print_run")},"Заказ стикеров рассчитан по подтверждённому количеству");}
export async function changeStickerOrderStatus(d:FormData){await run("change_sticker_order_status",{p_order_id:uuid(d,"order_id"),p_status:text(d,"status")},"Статус заказа стикеров изменён");}
export async function recordStickerApplication(d:FormData){await run("record_sticker_application",{p_item_id:uuid(d,"item_id"),p_applied:num(d,"applied"),p_spoiled:num(d,"spoiled"),p_applied_by_name:text(d,"applied_by_name")},"Нанесение и брак сохранены");}
export async function createMarkingOrder(d:FormData){await run("create_marking_code_order",{p_partner_id:uuid(d,"partner_id",false),p_shipment_id:uuid(d,"shipment_id",false),p_product_id:uuid(d,"product_id"),p_quantity:num(d,"quantity"),p_code_type:text(d,"code_type")},"Заказ кодов маркировки создан");}
export async function updateMarkingOrder(d:FormData){await run("update_marking_code_order",{p_order_id:uuid(d,"order_id"),p_status:text(d,"status"),p_quantity_received:num(d,"quantity_received"),p_quantity_applied:num(d,"quantity_applied"),p_codes_document_id:uuid(d,"codes_document_id",false)},"Данные маркировки обновлены");}
