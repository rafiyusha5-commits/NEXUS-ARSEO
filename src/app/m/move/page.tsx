import { MoveView, type MoveBalance, type MoveLocation } from "@/components/mobile-move";
import { requirePageUser } from "@/lib/auth/access";
import { type ScanResult, type StockRow } from "@/lib/scan/lookup";
import { moveBetweenLocations } from "./actions";

type Search = { balance?: string; to?: string; code?: string; batch?: string; via?: string; gs1_error?: string; error?: string; success?: string };
type BalanceRow = { id: string; warehouse_id: string; warehouse_location_id: string | null; uom: string; quantity_on_hand: string; quantity_reserved: string;
  batch: { batch_number: string; expiry_date: string | null; status: string; product: { internal_sku: string; name: Record<string, string> | null } | null } | null;
  location: { code: string } | null; warehouse: { code: string } | null };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sourcesOf(result: ScanResult, batch: string | null): StockRow[] {
  const rows = result.kind === "product" ? result.products.flatMap(product => product.stock)
    : result.kind === "location" || result.kind === "batch" ? result.stock : [];
  return rows.filter(row => Number(row.free) > 0 && row.batch_status === "available" && (!batch || row.batch === batch));
}

// Moving between places from a phone (202611280600). The page only finds what to move and where; the move itself is a
// posted transfer document.
export default async function MobileMovePage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const { supabase } = await requirePageUser();
  const code = (query.code ?? "").trim().slice(0, 200);
  const batch = query.batch?.trim().slice(0, 40) || null;
  const message = query.error ? { type: "error" as const, text: query.error } : query.success ? { type: "success" as const, text: query.success } : null;
  const lookup = code && !query.gs1_error ? await supabase.rpc("scan_lookup", { p_code: code, p_batch_number: batch }) : null;
  const result = (lookup?.data ?? null) as ScanResult | null;
  if (!query.balance || !uuidPattern.test(query.balance)) {
    const unavailable = lookup?.error ? { type: "error" as const, text: "Поиск недоступен: нужно право на остатки или на товары" } : null;
    return <MoveView code={code} sources={code && !unavailable ? (result ? sourcesOf(result, batch) : []) : null} message={unavailable ?? message} moveAction={moveBetweenLocations}/>;
  }
  const { data } = await supabase.from("inventory_balances")
    .select("id,warehouse_id,warehouse_location_id,uom,quantity_on_hand,quantity_reserved,batch:inventory_batches(batch_number,expiry_date,status,product:products(internal_sku,name)),location:warehouse_locations(code),warehouse:warehouses(code)")
    .eq("id", query.balance).maybeSingle();
  const row = data as unknown as BalanceRow | null;
  if (!row) return <MoveView message={{ type: "error", text: "Остаток не найден или недоступен" }} moveAction={moveBetweenLocations}/>;
  const balance: MoveBalance = {
    id: row.id, warehouse_id: row.warehouse_id, warehouse: row.warehouse?.code ?? "—", location_id: row.warehouse_location_id, location: row.location?.code ?? null,
    sku: row.batch?.product?.internal_sku ?? "—", product: row.batch?.product?.name?.ru ?? row.batch?.product?.internal_sku ?? "—",
    batch: row.batch?.batch_number ?? "—", expiry_date: row.batch?.expiry_date ?? null, batch_status: row.batch?.status ?? "", uom: row.uom,
    on_hand: Number(row.quantity_on_hand), reserved: Number(row.quantity_reserved),
  };
  const { data: places } = await supabase.from("warehouse_locations").select("id,code,zone").eq("warehouse_id", row.warehouse_id).eq("status", "active").order("code").limit(1000);
  const locations = (places ?? []) as MoveLocation[];
  let destination: MoveLocation | null = null;
  let warning: string | null = null;
  if (query.to) destination = locations.find(location => location.id === query.to) ?? null;
  else if (code) {
    if (result?.kind === "location" && result.location.warehouse_id === row.warehouse_id) destination = locations.find(location => location.id === result.location.id) ?? null;
    else if (result?.kind === "location") warning = `Место ${result.location.code} на складе ${result.location.warehouse}: между складами перемещайте документом в полной версии`;
    else warning = query.gs1_error ? "Код не разобран" : "Это не этикетка места — отсканируйте этикетку места назначения";
    if (result?.kind === "location" && result.location.warehouse_id === row.warehouse_id && !destination) warning = `Место ${result.location.code} не действует`;
  }
  if (destination && destination.id === balance.location_id) { warning = "Это то же место — выберите другое"; destination = null; }
  return <MoveView code={code} balance={balance} locations={locations} destination={destination} warning={warning} message={message} moveAction={moveBetweenLocations}/>;
}
