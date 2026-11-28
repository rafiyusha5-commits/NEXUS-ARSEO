import { notFound } from "next/navigation";
import Link from "next/link";
import { MobileCountView, type CountPlace, type CountProduct } from "@/components/mobile-count";
import { requirePageUser } from "@/lib/auth/access";
import { type CatalogProduct, type CountSheet } from "@/lib/inventory/counts";
import { type ScanResult } from "@/lib/scan/lookup";
import { recordMobileCount } from "../actions";

type Search = { location?: string; code?: string; batch?: string; via?: string; gs1_error?: string; error?: string; success?: string };

// Counting one inventory count from a phone. A scanned place label chooses the place; a product or batch code finds the
// product in the scope of the count (GTIN with or without the leading zero, the box code with its unit, the batch).
export default async function MobileCountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase } = await requirePageUser();
  const code = (query.code ?? "").trim().slice(0, 200);
  const batch = query.batch?.trim().slice(0, 40) || null;
  const [sheetResult, lookup] = await Promise.all([
    supabase.rpc("inventory_count_sheet", { p_count_id: id }),
    code && !query.gs1_error ? supabase.rpc("scan_lookup", { p_code: code, p_batch_number: batch }) : Promise.resolve(null),
  ]);
  if (sheetResult.error || !sheetResult.data) return <>
    <h1 className="mobile-title">Инвентаризация</h1>
    <section className="mobile-card mobile-card-warning"><strong>Пересчёт недоступен</strong><small>Нет доступа к инвентаризации или пересчёта нет.</small></section>
    <p><Link href="/m/count">← Инвентаризации</Link></p>
  </>;
  const sheet = sheetResult.data as CountSheet;
  const result = (lookup?.data ?? null) as ScanResult | null;
  const placeOf = (key: string | undefined): CountPlace | null => key === "none" ? (sheet.no_location ? { id: null, code: "Без зоны" } : null)
    : sheet.locations.find(location => location.id === key) ?? null;
  let place = placeOf(query.location);
  let warning: string | null = query.gs1_error ? "Код не разобран — проверьте этикетку" : null;
  let products: CountProduct[] | null = null;
  if (result?.kind === "location") {
    const scanned = placeOf(result.location.id);
    if (scanned) place = scanned;
    else warning = `Место ${result.location.code} не входит в этот пересчёт`;
  } else if (code && !query.gs1_error && place) {
    // The product found by the scan, searched in the scope of the count by its article; a typed text searches as is.
    const wanted = result?.kind === "product" ? result.products.map(product => ({ id: product.product_id, sku: product.sku, uom: product.uom }))
      : result?.kind === "batch" ? [{ id: result.batch.product_id, sku: result.batch.sku, uom: null }] : [];
    const queries = wanted.length ? [...new Set(wanted.map(item => item.sku))] : [code];
    const found = (await Promise.all(queries.map(text => supabase.rpc("inventory_count_catalog", { p_count_id: id, p_query: text }))))
      .flatMap(response => (response.data ?? []) as CatalogProduct[]);
    const unique = [...new Map(found.map(product => [product.id, product])).values()];
    products = (wanted.length ? unique.filter(product => wanted.some(item => item.id === product.id)) : unique).slice(0, 10).map(product => {
      const scannedBatch = result?.kind === "batch" ? result.batch.id : batch ? product.batches.find(item => item.batch === batch)?.id ?? "" : null;
      return { ...product, batch_id: scannedBatch, uom: wanted.find(item => item.id === product.id)?.uom ?? null };
    });
  } else if (code && !place) warning = "Сначала отсканируйте этикетку места";
  const message = query.error ? { type: "error" as const, text: query.error } : query.success ? { type: "success" as const, text: query.success } : null;
  return <MobileCountView sheet={sheet} place={place} products={products} code={code} warning={warning} message={message} recordAction={recordMobileCount}/>;
}
