/** How the price of an order line was obtained (202611170200, 202611180100), from the line's own snapshot. */
export type PriceSnapshot = {
  price?: string | number | null; reason?: string | null; note?: string | null; source?: string | null;
  price_type_name?: string | null; brand?: string | null; percent?: string | number | null; vat_included?: boolean | null;
  base_price?: string | number | null; base_currency?: string | null; rate?: string | number | null; rate_date?: string | null; rate_path?: string | null;
  program?: string | null; version?: number | null; agreed_quantity?: string | number | null;
  price_list_quote?: PriceSnapshot | null;
};
export type PricedLine = {
  unit_price: string | number | null; price_source: string | null; price_snapshot: PriceSnapshot | null;
  price_reason: string | null; program_quantity: string | number | null;
};

/** Why there is no price, in words an employee can act on. Shared with the assistant review. */
export const NO_PRICE_REASONS: Record<string, string> = {
  no_price_type: "у клиента не задан вид цены — карточка покупателя, вкладка «Цены»",
  currency_mismatch: "валюта заказа не совпадает с валютой контракта клиента",
  no_packaging: "у товара нет упаковки для этой единицы",
  fixed_price_currency: "фиксированная цена клиента задана в другой валюте",
  no_price: "в прайсе нет цены этого вида на дату заказа",
  no_brand: "бренд товара не найден в справочнике брендов (до 18.11.2026; теперь — цена прайса без процента)",
  no_rate: "нет официального курса за 7 дней до даты заказа",
  invalid_uom: "неизвестная единица",
  order_currency_missing: "у заказа не указана валюта",
};

const number = (value: string | number | null | undefined) => value == null ? "" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 6 });
const day = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "";

export function describePriceList(snapshot: PriceSnapshot | null | undefined) {
  if (!snapshot) return "";
  if (snapshot.price == null) return `нет цены: ${NO_PRICE_REASONS[snapshot.reason ?? ""] ?? snapshot.reason ?? "причина не указана"}`;
  const parts = [snapshot.source === "fixed" ? "фиксированная цена клиента" : snapshot.price_type_name ?? "прайс"];
  if (snapshot.source !== "fixed") {
    if (snapshot.note === "brand_missing") parts.push("бренда нет в справочнике брендов — без процента");
    else if (snapshot.brand) parts.push(snapshot.percent == null ? `${snapshot.brand}: условие по бренду не задано` : `${snapshot.brand} ${Number(snapshot.percent) > 0 ? "+" : ""}${number(snapshot.percent)} %`);
    if (snapshot.rate_path && snapshot.rate_path !== "same") parts.push(`курс ${number(snapshot.rate)} от ${day(snapshot.rate_date)}`);
  }
  parts.push(snapshot.vat_included ? "с НДС" : "без НДС");
  return parts.join(" · ");
}

/** One line under the price: where it came from, or why there is none. */
export function OrderLinePrice({ line }: { line: PricedLine }) {
  const snapshot = line.price_snapshot;
  switch (line.price_source) {
    case "price_list": case "fixed":
      return <small>Из прайса: {describePriceList(snapshot)}</small>;
    case "manual":
      return <small>Цена вручную: {line.price_reason}. Прайс: {describePriceList(snapshot?.price_list_quote) || "—"}</small>;
    case "commercial_program":
      return <small>Цена программы «{snapshot?.program}» v{snapshot?.version} на согласованные {number(line.program_quantity)}</small>;
    case "none":
      return <small className="load-warning-text">Цена не подставлена: {NO_PRICE_REASONS[snapshot?.reason ?? ""] ?? snapshot?.reason}</small>;
    default:
      return <small>Цена указана до появления прайса</small>;
  }
}
