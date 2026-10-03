"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePortalUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";

export async function updatePortalProfile(formData: FormData) {
  const { supabase } = await requirePortalUser();
  const locale = String(formData.get("locale") ?? "ru");
  const phone = String(formData.get("phone") ?? "").trim();
  const { error } = await supabase.rpc("update_my_external_profile", { p_locale: locale, p_phone: phone });
  if (error) redirect(`/portal/profile?error=${encodeURIComponent(publicErrorMessage(error,"Не удалось обновить профиль."))}`);
  revalidatePath("/portal/profile");
  redirect("/portal/profile?success=" + encodeURIComponent("Профиль сохранён"));
}
