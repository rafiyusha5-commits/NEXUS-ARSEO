import type { Settings, Snapshot, Supply } from "./calculate.ts";
export type Profile = { id: string; name: string; supplier_id: string; settings: Settings; reason: string; created_at: string };
export type Workspace = {
  profiles: Profile[]; warehouses: { id: string; name: string }[]; suppliers: { id: string; name: string }[];
  profile: Profile | null; snapshot: Snapshot | null; fresh: boolean;
  sources: (Omit<Supply, "purpose" | "city"> & { signature: string })[];
  purposes: { id: string; source_key: string; source_signature: string; kz_quantity: number; export_quantity: number; city: string | null; reason: string; created_at: string; export_sale_id?: string | null; expiry?: string | null; manufactured?: string | null; arrival?: string | null }[];
  runs: { id: string; created_at: string; algorithm: string }[];
  decisions: { id: string; kind: string; forecast_id: string | null; purchase_plan_id: string | null; reason: string; created_at: string }[];
};
export const uuid = (value: unknown): string | null => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
export const cityName = (city: string) => city === "astana" ? "Астана" : "Алматы";
export function parseWorkspace(value: unknown): Workspace {
  if (!value || typeof value !== "object" || !Array.isArray((value as Workspace).profiles) || !Array.isArray((value as Workspace).sources)) throw new Error("Не удалось прочитать автозаказ");
  return value as Workspace;
}
