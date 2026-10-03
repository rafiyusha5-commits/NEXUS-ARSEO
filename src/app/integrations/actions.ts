"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PublicError, publicErrorMessage } from "@/lib/errors/public-message";
import { loadPermissions } from "@/lib/permissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECTIONS = new Set(["inbound", "outbound", "bidirectional"]);

function value(data: FormData, key: string) {
  const result = data.get(key);
  return typeof result === "string" ? result.trim() : "";
}

function id(data: FormData, key: string, optional = false) {
  const result = value(data, key);
  if (!result && optional) return null;
  if (!UUID.test(result)) throw new PublicError(`Проверьте поле ${key}`);
  return result;
}

function integrationsRedirect(message: string, error = false): never {
  redirect(`/integrations?${error ? "error" : "success"}=${encodeURIComponent(message)}`);
}

async function requireIntegrationPermission(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  permission: "integrations.manage" | "integrations.resolve",
) {
  const access = await loadPermissions(supabase, [permission] as const);
  if (!access[permission]) throw new PublicError("Недостаточно прав для этого действия.");
}

export async function configureIntegration(data: FormData) {
  try {
    const { supabase } = await requireUser();
    await requireIntegrationPermission(supabase, "integrations.manage");

    const direction = value(data, "direction");
    if (!DIRECTIONS.has(direction)) throw new PublicError("Выберите корректное направление обмена.");

    let config: unknown = {};
    const raw = value(data, "config");
    if (raw) config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new PublicError("Параметры интеграции должны быть объектом JSON.");
    }

    const { error } = await supabase.rpc("configure_integration", {
      p_integration_id: id(data, "integration_id"),
      p_direction: direction,
      p_config: config,
      p_is_active: data.get("is_active") === "on",
    });
    if (error) throw error;
  } catch (error) {
    integrationsRedirect(publicErrorMessage(error, "Не удалось сохранить настройки интеграции."), true);
  }

  revalidatePath("/integrations");
  integrationsRedirect("Настройки интеграции сохранены");
}

export async function resolveError(data: FormData) {
  const ignore = value(data, "decision") === "ignore";

  try {
    const { supabase } = await requireUser();
    await requireIntegrationPermission(supabase, "integrations.resolve");

    const { error } = await supabase.rpc("resolve_synchronization_error", {
      p_error_id: id(data, "error_id"),
      p_internal_id: id(data, "internal_id", true),
      p_external_code: value(data, "external_code") || null,
      p_note: value(data, "note") || null,
      p_ignore: ignore,
    });
    if (error) throw error;
  } catch (error) {
    integrationsRedirect(publicErrorMessage(error, "Не удалось обработать ошибку интеграции."), true);
  }

  revalidatePath("/integrations");
  integrationsRedirect(ignore ? "Ошибка отмечена как исключение" : "Запись сопоставлена");
}
