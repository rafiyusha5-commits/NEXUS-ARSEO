"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// Binding an unknown code to a product (owner decision В4): the database requires products.update and the confirmation,
// and writes the audit log. The product is chosen by its article.
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }

export async function bindScanCode(data: FormData) {
  const { supabase } = await requireUser();
  const code = text(data, "code");
  const back = (type: "error" | "success", message: string): never =>
    redirect(`/m/scan?code=${encodeURIComponent(code)}&${type}=${encodeURIComponent(message)}`);
  const { data: product } = await supabase.from("products").select("id").eq("internal_sku", text(data, "sku")).maybeSingle();
  if (!product) back("error", "Товар с таким артикулом не найден");
  const uom = text(data, "packaging_uom");
  const { error } = await supabase.rpc("bind_scan_code", {
    p_code: code, p_product_id: product!.id, p_identifier_type: text(data, "identifier_type"),
    p_packaging_uom: uom && uom !== "none" ? uom : null, p_confirmed: text(data, "confirmed") === "on",
  });
  if (error) back("error", ruleViolationMessage(error, "Не удалось привязать код."));
  back("success", "Код привязан к товару и записан в журнал действий.");
}
