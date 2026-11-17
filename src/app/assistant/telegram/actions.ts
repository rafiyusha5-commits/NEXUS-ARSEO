"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { telegramConfig } from "@/lib/telegram/config.ts";

async function context() {
  const value = await requireUser();
  const can = await loadPermissions(value.supabase, ["agent.use"] as const);
  if (!can["agent.use"]) throw new Error("AGENT_FORBIDDEN");
  return value;
}

export async function createTelegramLink(_state: { url: string; error: string }, _form: FormData): Promise<{ url: string; error: string }> {
  void _state; void _form;
  try {
    const { supabase } = await context();
    const config = telegramConfig();
    if (!config) return { url: "", error: "Telegram ещё не настроен на сервере Nexus." };
    const result = await supabase.rpc("create_my_telegram_code");
    if (result.error || typeof result.data !== "string" || !/^[a-f0-9]{64}$/.test(result.data)) return { url: "", error: "Не удалось создать ссылку. Проверьте применение миграции Telegram." };
    return { url: `https://t.me/${config.username}?start=${result.data}`, error: "" };
  } catch { return { url: "", error: "Нет доступа или сессия истекла." }; }
}

export async function confirmTelegramLink() {
  const { supabase } = await context();
  const result = await supabase.rpc("confirm_my_telegram_link");
  revalidatePath("/assistant/telegram");
  redirect(result.error ? "/assistant/telegram?error=confirm" : "/assistant/telegram?success=confirmed");
}

export async function unlinkTelegram() {
  const { supabase } = await requireUser();
  const result = await supabase.rpc("unlink_my_telegram");
  revalidatePath("/assistant/telegram");
  redirect(result.error ? "/assistant/telegram?error=unlink" : "/assistant/telegram?success=unlinked");
}

export async function saveTelegramNotifications(form: FormData) {
  const { supabase } = await requireUser();
  const types = form.getAll("types").filter((value): value is string => typeof value === "string").slice(0, 10);
  const result = await supabase.rpc("set_my_telegram_notifications", { p_enabled: form.get("enabled") === "on", p_types: types });
  revalidatePath("/assistant/telegram");
  redirect(result.error ? "/assistant/telegram?error=notifications" : "/assistant/telegram?success=notifications");
}
