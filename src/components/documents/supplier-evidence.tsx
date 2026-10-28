import { isCommodityInvoice } from "@/lib/document-extraction/commodity-evidence";
import { isPackingEvidence } from "@/lib/document-extraction/packing-evidence";

export function SupplierEvidence({ invoice, packing, current }: { invoice: unknown; packing: unknown; current: boolean }) {
  if (!current) return null;
  const bill = isCommodityInvoice(invoice) ? invoice : null;
  const pack = isPackingEvidence(packing) ? packing : null;
  if (!bill && !pack) return null;
  const quantities = new Map<string, number>();
  for (const row of pack?.items ?? []) {
    const key = `${row.sku} · ${row.unit === "piece" ? "шт." : row.unit}`;
    quantities.set(key, (quantities.get(key) ?? 0) + row.quantity);
  }
  const num = (value: number | null) => value === null ? "Не прочитано" : value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
  return <div className="setup-notice" style={{ minWidth: 0, contain: "inline-size" }}>
    {bill && <><h4>Товары по инвойсу {bill.number}</h4><div className="table-wrap"><table className="data-table"><thead><tr><th>Артикул</th><th>Товар</th><th>Количество</th><th>Сумма</th></tr></thead><tbody>{bill.items.map((row, index) => <tr key={index}><td>{row.sku ?? "Не прочитан"}</td><td>{row.description}</td><td>{num(row.quantity)} {row.unit === "piece" ? "шт." : row.unit}</td><td>{num(row.amount)} {bill.currency}</td></tr>)}</tbody></table></div><p>Итого по инвойсу: {num(bill.total)} {bill.currency}.</p>{bill.warnings.map((warning, index) => <p className="login-error" key={index}>{warning}</p>)}</>}
    {pack && <><h4>Товары по упаковочному листу {pack.number}</h4><p>Партии одного артикула суммированы в одинаковых единицах. Короба переводятся в штуки только при явно указанной упаковке в документе.</p><div className="table-wrap"><table className="data-table"><thead><tr><th>Артикул и единица</th><th>Количество</th></tr></thead><tbody>{[...quantities].map(([key, quantity]) => <tr key={key}><td>{key}</td><td>{num(quantity)}</td></tr>)}</tbody></table></div><p>Общее количество по документу: {num(pack.total)}.</p>{pack.warnings.map((warning, index) => <p className="login-error" key={index}>{warning}</p>)}</>}
    <p>Сверьте с оригиналом. Это чтение документа, а не подтверждение фактической приёмки. Количества поставки, остатки и расходы не изменены.</p>
  </div>;
}
