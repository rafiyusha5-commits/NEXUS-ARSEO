"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PublicError, ruleViolationMessage } from "@/lib/errors/public-message";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function val(d:FormData,k:string){const v=d.get(k);return typeof v==="string"?v.trim():"";}
function uid(d:FormData,k:string,required=true){const v=val(d,k);if(!v&&!required)return null;if(!UUID.test(v))throw new PublicError(`Проверьте поле ${k}`);return v;}
function num(d:FormData,k:string){const n=Number(val(d,k));if(!Number.isFinite(n))throw new PublicError(`Проверьте поле ${k}`);return n;}
function go(message:string,error=false){redirect(`/finance?${error?"error":"success"}=${encodeURIComponent(message)}`);}
// go() redirects by throwing, and every action calls it inside its try block: let that through, otherwise each
// success would be reported as a failure. Business rules of the costing RPCs ("Укажите причину отмены") are shown as written.
function message(e:unknown){unstable_rethrow(e);return ruleViolationMessage(e);}

export async function addRate(d:FormData){try{const{supabase}=await requireUser();const{error}=await supabase.rpc("add_exchange_rate",{p_base_currency_id:uid(d,"base_currency_id"),p_quote_currency_id:uid(d,"quote_currency_id"),p_rate:num(d,"rate"),p_source:val(d,"source"),p_source_name:val(d,"source_name")||null,p_rate_date:val(d,"rate_date")});if(error)throw error;revalidatePath("/finance");go("Курс добавлен");}catch(e){go(message(e),true);}}
export async function createExpense(d:FormData){try{const{supabase}=await requireUser();const{error}=await supabase.rpc("create_expense",{p_shipment_id:uid(d,"shipment_id"),p_expense_type:val(d,"expense_type"),p_payee_counterparty_id:uid(d,"payee_counterparty_id",false),p_amount:num(d,"amount"),p_currency_id:uid(d,"currency_id"),p_incurred_at:val(d,"incurred_at"),p_is_planned:val(d,"is_planned")==="true",p_document_id:uid(d,"document_id",false),p_notes:val(d,"notes")||null});if(error)throw error;revalidatePath("/finance");go("Расход сохранён как черновик");}catch(e){go(message(e),true);}}
async function simpleRpc(d:FormData,name:string,arg:string,success:string){try{const{supabase}=await requireUser();const{error}=await supabase.rpc(name,{[arg]:uid(d,arg)});if(error)throw error;revalidatePath("/finance");go(success);}catch(e){go(message(e),true);}}
export async function confirmExpense(d:FormData){return simpleRpc(d,"confirm_expense","p_expense_id","Расход подтверждён");}
export async function payExpense(d:FormData){return simpleRpc(d,"mark_expense_paid","p_expense_id","Оплата подтверждена");}
async function reasonRpc(d:FormData,name:string,success:string){try{const{supabase}=await requireUser();const reason=val(d,"reason");if(!reason)throw new PublicError("Укажите причину");if(reason.length>500)throw new PublicError("Причина длиннее 500 символов");const{error}=await supabase.rpc(name,{p_expense_id:uid(d,"p_expense_id"),p_reason:reason});if(error)throw error;revalidatePath("/finance");go(success);}catch(e){go(message(e),true);}}
export async function cancelExpense(d:FormData){return reasonRpc(d,"cancel_expense","Расход отменён");}
export async function reverseExpense(d:FormData){return reasonRpc(d,"reverse_expense","Расход сторнирован");}
export async function allocateExpense(d:FormData){try{const{supabase}=await requireUser();const{error}=await supabase.rpc("allocate_expense",{p_expense_id:uid(d,"p_expense_id"),p_method:val(d,"method"),p_target_currency_id:uid(d,"target_currency_id")});if(error)throw error;revalidatePath("/finance");go("Расход распределён");}catch(e){go(message(e),true);}}
export async function calculateCost(d:FormData){try{const{supabase}=await requireUser();const{error}=await supabase.rpc("calculate_shipment_cost",{p_shipment_id:uid(d,"shipment_id"),p_target_currency_id:uid(d,"target_currency_id")});if(error)throw error;revalidatePath("/finance");go("Себестоимость рассчитана");}catch(e){go(message(e),true);}}
export async function approveCost(d:FormData){return simpleRpc(d,"approve_shipment_cost","p_calculation_id","Себестоимость утверждена и записана в партии");}
