"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import { parseExactAllocation } from "@/lib/finance/exact-allocation";

export type AllocationResult = { error?: string; success?: string };
export async function saveAllocation(_state: AllocationResult, form: FormData): Promise<AllocationResult> {
  try {
    const { supabase } = await requireUser();
    const args = parseExactAllocation(form);
    const { error } = await supabase.rpc("save_exact_expense_allocation", args);
    if (error) throw error;
    revalidatePath("/finance");
    revalidatePath(`/finance/expenses/${args.p_expense_id}/allocation`);
    return { success: "Распределение сохранено. Оплата и утверждение себестоимости не выполнялись." };
  } catch (e) {
    unstable_rethrow(e);
    if (e && typeof e === "object" && "code" in e && e.code === "40001") return { error: "Исходные данные изменились. Обновите страницу и проверьте суммы заново." };
    return { error: ruleViolationMessage(e) };
  }
}
