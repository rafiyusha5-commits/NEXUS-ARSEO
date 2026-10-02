import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/access";
import { createXlsx, type XlsxCell } from "@/lib/xlsx";

type LocalizedText = { ru?: string; en?: string; kk?: string } | null;
type Identifier = { identifier_type: string; value: string; counterparty_id: string | null };
type Packaging = {
  uom: string;
  units_per_parent: number;
  gross_weight_kg: number | null;
  net_weight_kg: number | null;
  volume_m3: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
};
type Product = {
  internal_sku: string;
  name: LocalizedText;
  brand: string | null;
  category: string | null;
  country_of_origin: string | null;
  hs_code: string | null;
  temperature_regime: string | null;
  temperature_range: string | null;
  shelf_life_days: number | null;
  base_uom: string;
  requires_marking: boolean;
  requires_sticker: boolean;
  status: string;
  identifiers: Identifier[] | null;
  packaging: Packaging[] | null;
};
type SupplierLink = { status: string; is_primary: boolean; product: Product | Product[] | null };

const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;
const text = (value: unknown) => value === null || value === undefined ? "" : String(value);
const yesNo = (value: boolean) => value ? "Да" : "Нет";

function identifier(product: Product, type: string, counterpartyId?: string) {
  return product.identifiers?.find((item) => item.identifier_type === type && (!counterpartyId || item.counterparty_id === counterpartyId))?.value ?? "";
}

function packaging(product: Product) {
  return [...(product.packaging ?? [])]
    .sort((left, right) => left.uom.localeCompare(right.uom, "ru"))
    .map((item) => [
      item.uom,
      `кратность ${text(item.units_per_parent)}`,
      item.net_weight_kg == null ? "" : `нетто ${item.net_weight_kg} кг`,
      item.gross_weight_kg == null ? "" : `брутто ${item.gross_weight_kg} кг`,
      item.volume_m3 == null ? "" : `объём ${item.volume_m3} м³`,
      [item.length_cm, item.width_cm, item.height_cm].every((value) => value != null)
        ? `${item.length_cm}×${item.width_cm}×${item.height_cm} см`
        : "",
    ].filter(Boolean).join(" · "))
    .join("; ");
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireUser();
  const { data: party } = await supabase
    .from("counterparties")
    .select("id,legal_name,short_name")
    .eq("id", id)
    .maybeSingle();
  if (!party) return NextResponse.json({ error: "Контрагент не найден" }, { status: 404 });

  const { data, error } = await supabase
    .from("product_suppliers")
    .select("status,is_primary,product:products(internal_sku,name,brand,category,country_of_origin,hs_code,temperature_regime,temperature_range,shelf_life_days,base_uom,requires_marking,requires_sticker,status,identifiers:product_identifiers(identifier_type,value,counterparty_id),packaging:product_packaging(uom,units_per_parent,gross_weight_kg,net_weight_kg,volume_m3,length_cm,width_cm,height_cm))")
    .eq("supplier_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const links = (data ?? []) as unknown as SupplierLink[];
  const rows: XlsxCell[][] = links
    .map((link) => ({ link, product: one(link.product) }))
    .filter((item): item is { link: SupplierLink; product: Product } => Boolean(item.product))
    .sort((left, right) => left.product.internal_sku.localeCompare(right.product.internal_sku, "ru", { numeric: true }))
    .map(({ link, product }) => [
      product.internal_sku,
      identifier(product, "supplier_sku", id),
      product.name?.ru ?? "",
      product.name?.en ?? "",
      product.name?.kk ?? "",
      product.brand ?? "",
      product.category ?? "",
      product.country_of_origin ?? "",
      product.hs_code ?? "",
      identifier(product, "gtin"),
      identifier(product, "unit_barcode"),
      identifier(product, "box_barcode"),
      product.base_uom,
      product.shelf_life_days,
      product.temperature_regime ?? "",
      product.temperature_range ?? "",
      packaging(product),
      yesNo(product.requires_marking),
      yesNo(product.requires_sticker),
      link.is_primary ? "Основной" : "Дополнительный",
      link.status === "active" ? "Активен" : "Неактивен",
      product.status,
    ]);

  const header: XlsxCell[] = [
    "Внутренний артикул", "Артикул поставщика", "Наименование RU", "Наименование EN", "Наименование KZ",
    "Бренд", "Категория", "Страна происхождения", "Код ТН ВЭД", "GTIN", "Штрихкод единицы",
    "Штрихкод короба", "Базовая единица", "Срок годности, дней", "Температурный режим",
    "Температурный диапазон", "Упаковка и логистика", "Требуется маркировка", "Требуется стикеровка",
    "Тип связи", "Статус в ассортименте", "Статус товара",
  ];
  const file = createXlsx([{ name: "Товары", rows: [header, ...rows] }]);
  const fileName = `supplier-products-${id}.xlsx`;
  const displayName = `${party.short_name || party.legal_name}-товары.xlsx`.replace(/[\\/:*?"<>|]+/g, "-");
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
