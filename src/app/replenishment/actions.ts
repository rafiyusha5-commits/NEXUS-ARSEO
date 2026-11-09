"use server";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { PublicError, ruleViolationMessage } from "@/lib/errors/public-message";
import { calculate, type Settings } from "@/lib/replenishment/calculate";
import { parseWorkspace, uuid } from "@/lib/replenishment/workspace";
const field = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const id = (data: FormData, key: string) => { const n = uuid(field(data, key)); if (!n) throw new PublicError("Выберите запись"); return n; };
const number = (data: FormData, key: string) => { const raw = field(data, key).replace(",", "."), n = Number(raw); if (!raw || !Number.isFinite(n)) throw new PublicError("Проверьте числовые поля"); return n; };
function back(profile: string | null, run: string | null, error: unknown): never {
  const q = new URLSearchParams({ message: ruleViolationMessage(error) });
  if (profile) q.set("profile", profile); if (run) q.set("run", run);
  redirect(`/replenishment?${q}`);
}
export async function createProfile(data: FormData) {
  let created: string;
  try {
    const { supabase } = await requireUser();
    const overrides: Settings["overrides"] = [];
    for (const product of data.getAll("product_id")) for (const city of ["astana", "almaty"] as const) {
      const key = `${product}:${city}`;
      if (field(data, key)) overrides.push({ productId: String(product), city, daily: number(data, key), reason: field(data, `${key}:reason`) });
    }
    const settings: Settings = { aktobe: id(data, "aktobe"), astana: id(data, "astana"), almaty: id(data, "almaty"), productionDays: number(data, "productionDays"), transitDays: number(data, "transitDays"), cityDays: number(data, "cityDays"), reviewDays: number(data, "reviewDays"), transferDays: number(data, "transferDays"), historyDays: number(data, "historyDays"), serviceZ: number(data, "serviceZ"), historyConfirmed: data.get("historyConfirmed") === "on", overrides };
    const result = await supabase.rpc("replenishment_create_profile", { p_supplier_id: id(data, "supplier"), p_name: field(data, "name"), p_settings: settings, p_reason: field(data, "reason") });
    if (result.error) throw result.error; created = String(result.data);
  } catch (error) { back(uuid(field(data, "profile")), null, error); }
  revalidatePath("/replenishment"); redirect(`/replenishment?profile=${created}`);
}
export async function setPurpose(data: FormData) {
  const profile = uuid(field(data, "profile"));
  try {
    const { supabase } = await requireUser();
    const { error } = await supabase.rpc("replenishment_set_purpose", { p_profile_id: id(data, "profile"), p_source_key: field(data, "source"), p_signature: field(data, "signature"), p_kz: number(data, "kz"), p_export: number(data, "export"), p_city: field(data, "city") || null, p_export_sale_id: field(data, "export_sale_id") ? id(data, "export_sale_id") : null, p_reason: field(data, "reason"), p_expiry: field(data, "expiry") || null, p_manufactured: field(data, "manufactured") || null, p_arrival: field(data, "arrival") || null });
    if (error) throw error;
  } catch (error) { back(profile, null, error); }
  revalidatePath("/replenishment"); redirect(`/replenishment?profile=${profile}#supply`);
}
export async function capture(data: FormData) {
  const profile = uuid(field(data, "profile")); let run: string;
  try {
    const { supabase } = await requireUser();
    const { data: result, error } = await supabase.rpc("replenishment_capture", { p_profile_id: id(data, "profile"), p_request_id: uuid(field(data, "request")) ?? randomUUID() });
    if (error) throw error; run = String(result);
  } catch (error) { back(profile, null, error); }
  revalidatePath("/replenishment"); redirect(`/replenishment?run=${run}#result`);
}
export async function prepareDraft(data: FormData) {
  const run = uuid(field(data, "run")); let destination: string;
  try {
    const { supabase } = await requireUser();
    const response = await supabase.rpc("replenishment_workspace", { p_run_id: id(data, "run") });
    if (response.error) throw response.error;
    const workspace = parseWorkspace(response.data);
    if (!workspace.snapshot || !workspace.fresh) throw new PublicError("Данные изменились. Сохраните новый расчёт.");
    const result = calculate(workspace.snapshot);
    if (result.lines.some(l => l.blockers.length) || result.warnings.length) throw new PublicError("Сначала устраните замечания исходных данных.");
    const kind = field(data, "kind");
    if (!["forecast", "purchase"].includes(kind)) throw new PublicError("Выберите действие");
    if (kind === "purchase" && result.transfers.length > 0 && data.get("use_existing_kz") !== "on") throw new PublicError("Подтвердите использование существующего запаса Казахстана и подготовку перемещений.");
    const lines = kind === "forecast"
      ? result.lines.map(l => ({ productId: l.productId, city: l.city, quantity: Math.ceil(l.forecastDemand) })).filter(l => l.quantity > 0)
      : workspace.snapshot.products.map(p => {
        const rows = result.lines.filter(l => l.productId === p.id);
        return { productId: p.id, quantity: rows.reduce((n, l) => n + l.afterTransfers, 0), stock: rows.reduce((n, l) => n + l.usable + l.proposedTransfer, 0), inbound: rows.reduce((n, l) => n + l.inbound, 0), safety: rows.reduce((n, l) => n + l.safety, 0) };
      }).filter(l => l.quantity > 0);
    if (!lines.length) throw new PublicError("Нет положительной потребности для черновика.");
    const reason = field(data, "reason");
    if (reason.length < 3 || reason.length > 800) throw new PublicError("Укажите причину от 3 до 800 символов.");
    const draft = await supabase.rpc("replenishment_prepare_draft", { p_run_id: run, p_kind: kind, p_lines: lines, p_reason: reason + (kind === "purchase" && result.transfers.length ? " · Существующий запас KZ учтён; перемещения подготовить отдельно." : ""), p_forecast_id: kind === "purchase" ? id(data, "forecast_id") : null });
    if (draft.error) throw draft.error;
    destination = kind === "forecast" ? `/forecasts?forecast=${draft.data}` : `/purchase-plans?plan=${draft.data}`;
  } catch (error) { back(null, run, error); }
  revalidatePath("/replenishment"); redirect(destination);
}
