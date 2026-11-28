import Link from "next/link";
import { requirePageUser } from "@/lib/auth/access";

type Search = { kind?: string; warehouse?: string; q?: string; error?: string };

// Labels of locations and batches (owner decision В3): choose, then print as an A4 sheet or thermal labels. The print
// is recorded (a reprint is marked); a label code never changes.
export default async function MobileLabelsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const { supabase } = await requirePageUser();
  const kind = params.kind === "batch" ? "batch" : "location";
  const { data: warehouses } = await supabase.from("warehouses").select("id,code,name").eq("status", "active").eq("is_virtual", false).order("code");
  const warehouse = (warehouses ?? []).find(item => item.id === params.warehouse)?.id ?? warehouses?.[0]?.id ?? null;
  const query = (params.q ?? "").trim().slice(0, 60);
  const [{ data: locations }, { data: batches }] = await Promise.all([
    kind === "location" && warehouse ? supabase.from("warehouse_locations").select("id,code,zone").eq("warehouse_id", warehouse).neq("status", "archived").order("code").limit(500)
      : Promise.resolve({ data: [] as Array<{ id: string; code: string; zone: string }> }),
    kind === "batch" && query ? supabase.from("inventory_batches").select("id,batch_number,expiry_date,product:products!inner(internal_sku,name)")
      .ilike("product.internal_sku", `%${query.replace(/[%_]/g, "")}%`).order("expiry_date", { ascending: true }).limit(100)
      : Promise.resolve({ data: [] as Array<{ id: string; batch_number: string; expiry_date: string | null; product: unknown }> }),
  ]);
  const name = (value: unknown) => {
    const product = (Array.isArray(value) ? value[0] : value) as { internal_sku?: string; name?: { ru?: string } } | null;
    return product ? `${product.internal_sku ?? ""} · ${product.name?.ru ?? ""}` : "—";
  };
  return <>
    <h1 className="mobile-title">Этикетки</h1>
    {params.error && <div className="login-error admin-message">{params.error}</div>}
    <nav className="operation-tab-list" aria-label="Что печатать">
      <Link className="operation-tab-button" aria-current={kind === "location" ? "page" : undefined} href="/m/labels">Места</Link>
      <Link className="operation-tab-button" aria-current={kind === "batch" ? "page" : undefined} href="/m/labels?kind=batch">Партии</Link>
    </nav>
    <form className="mobile-form" action="/m/labels">
      <input type="hidden" name="kind" value={kind}/>
      {kind === "location"
        ? <label>Склад<select name="warehouse" defaultValue={warehouse ?? ""}>{(warehouses ?? []).map(item => <option key={item.id} value={item.id}>{(item.name as { ru?: string } | null)?.ru ?? item.code}</option>)}</select></label>
        : <label>Артикул товара<input name="q" defaultValue={query} required autoCapitalize="characters"/></label>}
      <button className="ghost scan-button" type="submit">Показать</button>
    </form>
    <form className="mobile-form" method="post" action="/m/labels/print" target="_blank">
      <input type="hidden" name="target_type" value={kind}/>
      <div className="mobile-checklist">
        {kind === "location" && (locations ?? []).map(item => <label className="check-label" key={item.id}><input type="checkbox" name="ids" value={item.id}/> {item.code} <small>{item.zone}</small></label>)}
        {kind === "batch" && (batches ?? []).map(item => <label className="check-label" key={item.id}><input type="checkbox" name="ids" value={item.id}/> {name(item.product)} · {item.batch_number}{item.expiry_date ? ` · до ${item.expiry_date}` : ""}</label>)}
        {kind === "location" && !(locations ?? []).length && <p className="mobile-hint">На складе нет мест.</p>}
        {kind === "batch" && query && !(batches ?? []).length && <p className="mobile-hint">Партий не найдено.</p>}
      </div>
      <label>Формат<select name="format" defaultValue="a4"><option value="a4">Лист A4: 24 этикетки 70×37 мм</option><option value="thermal">Термопринтер: 58×40 мм</option></select></label>
      <label>Копий каждой<input name="copies" type="number" min={1} max={100} defaultValue={1} required/></label>
      <button className="primary scan-button" type="submit">Печать (PDF)</button>
      <small className="mobile-hint">Каждая печать записывается; повторная отмечается как повторная. Код этикетки не меняется.</small>
    </form>
    <p><Link href="/m">← Склад</Link></p>
  </>;
}
