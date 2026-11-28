// The result of a lookup by code (202611280500): rendering only, shared by the mobile page and its browser test.
import { ScanFeedback } from "@/components/scan-feedback";
import { daysLeft, quantity, shortDate, uomName, viaLabel, type ScanResult, type StockRow } from "@/lib/scan/lookup";

type Params = { batch?: string; expiry?: string; qty?: string; via?: string };

export function ScanResultView({ result, today, params, bindAction }: { result: ScanResult; today: string; params: Params;
  bindAction: (data: FormData) => void | Promise<void> }) {
  const code = result.code;
  return <>
      <ScanFeedback ok={result.kind !== "unknown"} signature={`${code}:${params.via ?? ""}`}/>
      <p className="mobile-hint">Код {result.code}{params.via ? ` · ${viaLabel[params.via] ?? params.via}` : ""}{params.batch ? ` · партия ${params.batch}` : ""}{params.expiry ? ` · годен до ${shortDate(params.expiry)}` : ""}{params.qty ? ` · ${params.qty} шт. в коде` : ""}</p>
      {result.kind === "product" && result.products.map(product => <section className="mobile-card" key={`${product.product_id}-${product.uom}`}>
        <strong className="mobile-big">{product.product}</strong>
        <small>{product.sku} · {uomName[product.uom] ?? product.uom}{product.pieces && Number(product.pieces) !== 1 ? ` (${quantity(product.pieces)} шт.)` : ""}</small>
        {product.batch_found === false && <p className="load-warning-text">Партии {params.batch} в Nexus нет — её можно завести при приёмке.</p>}
        <Stock rows={product.stock} today={today}/>
      </section>)}
      {result.kind === "location" && <section className="mobile-card">
        <strong className="mobile-big">Место {result.location.code}</strong>
        <small>{result.location.warehouse} · {result.location.zone}{result.location.status !== "active" ? ` · ${result.location.status}` : ""}</small>
        <Stock rows={result.stock} today={today} showProduct/>
      </section>}
      {result.kind === "batch" && <section className="mobile-card">
        <strong className="mobile-big">{result.batch.product}</strong>
        <small>{result.batch.sku} · партия {result.batch.batch} · годен до {shortDate(result.batch.expiry_date)}</small>
        <Stock rows={result.stock} today={today}/>
      </section>}
      {result.kind === "unknown" && <section className="mobile-card mobile-card-warning">
        <strong className="mobile-big">Код не найден</strong>
        <small>{result.can_bind ? "Можно привязать его к товару — проверьте товар и упаковку." : "Сообщите сотруднику, который ведёт карточки товаров."}</small>
        {result.can_bind && <form action={bindAction} className="mobile-form">
          <input type="hidden" name="code" value={result.code}/>
          <label>Артикул товара<input name="sku" required autoCapitalize="characters"/></label>
          <label>Вид кода<select name="identifier_type" defaultValue="unit_barcode"><option value="unit_barcode">Штрихкод штуки</option><option value="box_barcode">Штрихкод коробки</option><option value="gtin">GTIN</option></select></label>
          <label>Упаковка<select name="packaging_uom" defaultValue="none"><option value="none">Не указывать</option><option value="piece">Штука</option><option value="box">Коробка</option><option value="layer">Слой</option><option value="pallet">Паллета</option></select></label>
          <label className="check-label"><input type="checkbox" name="confirmed" required/> Я проверил: этот код на упаковке выбранного товара</label>
          <button className="primary scan-button" type="submit">Привязать код</button>
        </form>}
      </section>}
    </>;
}

function Stock({ rows, today, showProduct = false }: { rows: StockRow[]; today: string; showProduct?: boolean }) {
  if (!rows.length) return <p className="mobile-hint">Свободного остатка нет.</p>;
  return <ul className="mobile-stock">{rows.map(row => {
    const left = daysLeft(row.expiry_date, today);
    return <li key={row.balance_id}>
      <div><strong>{showProduct ? `${row.sku} · ${row.product}` : `${row.warehouse} · ${row.location ?? "без зоны"}`}</strong>
        <small>партия {row.batch} · годен до {shortDate(row.expiry_date)}{left != null ? ` (${left < 0 ? "истёк" : `${left} дн.`})` : ""}{row.batch_status !== "available" ? ` · ${row.batch_status}` : ""}</small>
        {row.unit_cost && <small>себестоимость {quantity(row.unit_cost)} {row.cost_currency} за {uomName[row.cost_uom ?? "piece"] ?? row.cost_uom}</small>}</div>
      <div className="mobile-qty"><strong>{quantity(row.free)}</strong><small>свободно из {quantity(row.on_hand)} {row.uom === "piece" ? "шт." : uomName[row.uom] ?? row.uom}</small></div>
    </li>;
  })}</ul>;
}
