import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { linkEntityLabel, localizedName } from "./labels.ts";

export type LinkOption = { value: string; label: string };
export type LinkOptionGroup = { entityType: string; label: string; options: LinkOption[] };

type Row = Record<string, unknown>;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);
const SUPPLIER_ROLES = ["manufacturer", "supplier", "carrier", "broker", "printing_house"];

function counterpartyName(row: Row) {
  return String(row.short_name || row.legal_name || "Без названия");
}

// Objects a document can be linked to. Every query runs with the user's session, so the
// lists only contain objects the user may see; the database re-checks on insert.
export async function loadLinkOptions(supabase: SupabaseClient): Promise<LinkOptionGroup[]> {
  const [shipments, transports, counterparties, products, warehouses, contracts] = await Promise.all([
    supabase.from("shipments").select("id, shipment_number, project_code").order("created_at", { ascending: false }).limit(200),
    supabase.from("shipment_transports").select("id, sequence_no, shipment:shipments(shipment_number)").order("created_at", { ascending: false }).limit(200),
    supabase.from("counterparties").select("id, legal_name, short_name, roles").eq("status", "active").order("legal_name").limit(500),
    supabase.from("products").select("id, internal_sku, name").order("internal_sku").limit(500),
    supabase.from("warehouses").select("id, code, name").eq("status", "active").order("code"),
    supabase.from("contracts").select("id, number, counterparty:counterparties(legal_name, short_name)").order("created_at", { ascending: false }).limit(200),
  ]);

  const parties = (counterparties.data ?? []) as Row[];
  const groups: LinkOptionGroup[] = [
    {
      entityType: "shipment",
      label: "Поставки",
      options: ((shipments.data ?? []) as Row[]).map((row) => ({
        value: `shipment:${row.id}`,
        label: `${row.shipment_number}${row.project_code ? ` · ${row.project_code}` : ""}`,
      })),
    },
    {
      entityType: "shipment_transport",
      label: "Перевозки",
      options: ((transports.data ?? []) as Row[]).map((row) => ({
        value: `shipment_transport:${row.id}`,
        label: `${(one(row.shipment as Row | Row[]) as Row | undefined)?.shipment_number ?? "Поставка"} · автомобиль №${row.sequence_no}`,
      })),
    },
    {
      entityType: "supplier",
      label: "Поставщики и производители",
      options: parties
        .filter((row) => (row.roles as string[]).some((role) => SUPPLIER_ROLES.includes(role)))
        .map((row) => ({ value: `supplier:${row.id}`, label: counterpartyName(row) })),
    },
    {
      entityType: "customer",
      label: "Клиенты",
      options: parties
        .filter((row) => (row.roles as string[]).includes("customer"))
        .map((row) => ({ value: `customer:${row.id}`, label: counterpartyName(row) })),
    },
    {
      entityType: "product",
      label: "Товары",
      options: ((products.data ?? []) as Row[]).map((row) => ({
        value: `product:${row.id}`,
        label: `${row.internal_sku} · ${localizedName(row.name)}`,
      })),
    },
    {
      entityType: "warehouse",
      label: "Склады",
      options: ((warehouses.data ?? []) as Row[]).map((row) => ({
        value: `warehouse:${row.id}`,
        label: `${row.code} · ${localizedName(row.name)}`,
      })),
    },
    {
      entityType: "contract",
      label: "Контракты",
      options: ((contracts.data ?? []) as Row[]).map((row) => {
        const party = one(row.counterparty as Row | Row[]) as Row | undefined;
        return { value: `contract:${row.id}`, label: `№ ${row.number}${party ? ` · ${counterpartyName(party)}` : ""}` };
      }),
    },
  ];
  return groups.filter((group) => group.options.length > 0);
}

export type ResolvedLink = { label: string; href: string | null };

// Turns (entity_type, entity_id) pairs into readable names and links to their pages.
// Objects the user cannot see are shown as unavailable instead of leaking details.
export async function resolveLinkTargets(
  supabase: SupabaseClient,
  links: { entity_type: string; entity_id: string }[],
): Promise<Map<string, ResolvedLink>> {
  const idsOf = (type: string) => [...new Set(links.filter((link) => link.entity_type === type).map((link) => link.entity_id))];
  const result = new Map<string, ResolvedLink>();
  const counterpartyIds = [...new Set([...idsOf("supplier"), ...idsOf("customer")])];

  const [shipments, transports, counterparties, products, warehouses, contracts] = await Promise.all([
    idsOf("shipment").length ? supabase.from("shipments").select("id, shipment_number, project_code").in("id", idsOf("shipment")) : { data: [] },
    idsOf("shipment_transport").length
      ? supabase.from("shipment_transports").select("id, sequence_no, shipment_id, shipment:shipments(shipment_number)").in("id", idsOf("shipment_transport"))
      : { data: [] },
    counterpartyIds.length ? supabase.from("counterparties").select("id, legal_name, short_name").in("id", counterpartyIds) : { data: [] },
    idsOf("product").length ? supabase.from("products").select("id, internal_sku, name").in("id", idsOf("product")) : { data: [] },
    idsOf("warehouse").length ? supabase.from("warehouses").select("id, code, name").in("id", idsOf("warehouse")) : { data: [] },
    idsOf("contract").length ? supabase.from("contracts").select("id, number").in("id", idsOf("contract")) : { data: [] },
  ]);

  for (const row of (shipments.data ?? []) as Row[]) {
    result.set(`shipment:${row.id}`, { label: `${row.shipment_number}${row.project_code ? ` · ${row.project_code}` : ""}`, href: `/shipments/${row.id}` });
  }
  for (const row of (transports.data ?? []) as Row[]) {
    const shipment = one(row.shipment as Row | Row[]) as Row | undefined;
    result.set(`shipment_transport:${row.id}`, {
      label: `${shipment?.shipment_number ?? "Поставка"} · автомобиль №${row.sequence_no}`,
      href: `/shipments/${row.shipment_id}`,
    });
  }
  for (const row of (counterparties.data ?? []) as Row[]) {
    const link = { label: counterpartyName(row), href: "/counterparties" };
    result.set(`supplier:${row.id}`, link);
    result.set(`customer:${row.id}`, link);
  }
  for (const row of (products.data ?? []) as Row[]) {
    result.set(`product:${row.id}`, { label: `${row.internal_sku} · ${localizedName(row.name)}`, href: "/products" });
  }
  for (const row of (warehouses.data ?? []) as Row[]) {
    result.set(`warehouse:${row.id}`, { label: `${row.code} · ${localizedName(row.name)}`, href: "/warehouses" });
  }
  for (const row of (contracts.data ?? []) as Row[]) {
    result.set(`contract:${row.id}`, { label: `Контракт № ${row.number}`, href: "/counterparties" });
  }

  for (const link of links) {
    const key = `${link.entity_type}:${link.entity_id}`;
    if (!result.has(key)) {
      result.set(key, { label: `${linkEntityLabel[link.entity_type] ?? "Объект"} недоступен`, href: null });
    }
  }
  return result;
}
