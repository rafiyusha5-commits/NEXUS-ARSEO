"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import type { ImportPayload, ImportReview } from "@/lib/finance/import-review";

export async function previewImport(payload: ImportPayload): Promise<{ review?: ImportReview; error?: string }> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("preview_receivables_import", { p_payload: payload });
  if (error) return { error: ruleViolationMessage(error, "Не удалось проверить файл. Повторите попытку.") };
  return { review: data as ImportReview };
}

export async function confirmImport(requestId: string, payload: ImportPayload, fingerprint: string): Promise<{ message?: string; error?: string }> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("confirm_receivables_import", {
    p_request_id: requestId, p_payload: payload, p_fingerprint: fingerprint,
  });
  if (error) return { error: ruleViolationMessage(error, "Не удалось загрузить пакет. Повторите попытку.") };
  revalidatePath("/finance/receivables");
  revalidatePath("/finance/bank");
  return { message: `Пакет ${data.batch_id}: новых строк ${data.new}, ранее загруженных ${data.duplicates}.` };
}
