"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { replacementError, type Allocation, type ReplacementPreview, type ReplacementSnapshot } from "@/lib/sales/reservation-replacement";

export async function previewReservationReplacement(saleId: string, allocations: Allocation[] | null = null): Promise<{ data?: ReplacementPreview; error?: string }> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("preview_customer_order_reservation_replacement", { p_sale_id: saleId, p_allocations: allocations });
  return error ? { error: replacementError(error) } : { data: data as ReplacementPreview };
}

export async function commitReservationReplacement(saleId: string, requestId: string, expected: ReplacementSnapshot, allocations: Allocation[], reason: string): Promise<{ id?: string; error?: string }> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("replace_customer_order_reservations", {
    p_sale_id: saleId, p_request_id: requestId, p_expected: expected, p_allocations: allocations, p_reason: reason,
  });
  if (error) return { error: replacementError(error) };
  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/sales");
  revalidatePath("/inventory");
  return { id: data as string };
}
