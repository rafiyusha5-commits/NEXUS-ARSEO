import { AppSidebar } from "@/components/app-sidebar";
import { ProductSearchFieldSelect } from "@/components/product-search-field-select";
import { requireUser } from "@/lib/auth/access";
import { PRODUCT_CATEGORIES } from "@/lib/products/categories";
import { matchesProductSearch, PRODUCT_SEARCH_FIELDS, type ProductSearchField } from "@/lib/products/search";
import Link from "next/link";
import { createProduct } from "./actions";

type Manufacturer = { id?: string; legal_name: string };
type ProductSupplier = { status: string; supplier: Manufacturer | Manufacturer[] | null };
type ProductRow = {
  id: string; internal_sku: string; name: Record<string, string>; brand: string | null; category: string;
  hs_code: string | null; shelf_life_days: number | null; requires_marking: boolean; requires_sticker: boolean;
  counterparties: Manufacturer | Manufacturer[] | null;
  product_identifiers: { identifier_type: string; value: string }[];
  product_packaging: { uom: string; units_per_parent: number | string; gross_weight_kg: number | string | null; net_weight_kg: number | string | null }[];
  product_suppliers: ProductSupplier[];
};

function manufacturerOf(product: ProductRow) {
  return Array.isArray(product.counterparties) ? product.counterparties[0] : product.counterparties;
}

function unique(values: (string | null | undefined)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "ru"));
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{error?:string;success?:string;q?:string;search_by?:string;manufacturer?:string;supplier?:string;brand?:string;category?:string}> }) {
  const { profile, roles, supabase } = await requireUser();
  const params = await searchParams;
  const [{data,error},{data: manufacturers},{data: suppliers}] = await Promise.all([
    supabase.from("products").select("id, internal_sku, name, brand, category, hs_code, shelf_life_days, requires_marking, requires_sticker, counterparties!products_manufacturer_id_fkey(id, legal_name), product_identifiers(identifier_type, value), product_packaging(uom, units_per_parent, gross_weight_kg, net_weight_kg), product_suppliers(status,supplier:counterparties!product_suppliers_supplier_id_fkey(id,legal_name))").order("internal_sku"),
    supabase.from("counterparties").select("id, legal_name").contains("roles", ["manufacturer"]).eq("status","active").order("legal_name"),
    supabase.from("counterparties").select("id, legal_name").contains("roles", ["manufacturer"]).eq("status","active").order("legal_name"),
  ]);
  const products = ((data ?? []) as ProductRow[]).sort((a,b) => {
    const ma=manufacturerOf(a)?.legal_name ?? ""; const mb=manufacturerOf(b)?.legal_name ?? "";
    return ma.localeCompare(mb,"ru") || (a.brand??"").localeCompare(b.brand??"","ru") || a.category.localeCompare(b.category,"ru") || (a.name.ru??"").localeCompare(b.name.ru??"","ru");
  });
  const manufacturerOptions = unique(products.map(product => manufacturerOf(product)?.legal_name));
  const brandOptions = unique(products.map(product => product.brand));
  const categoryOptions = unique(products.map(product => product.category));
  const searchBy: ProductSearchField = PRODUCT_SEARCH_FIELDS.includes(params.search_by as ProductSearchField) ? params.search_by as ProductSearchField : "all";
  const filtered = products.filter(product =>
    matchesProductSearch({
      ...product,
      manufacturer: manufacturerOf(product)?.legal_name ?? null,
      identifiers: product.product_identifiers,
      packaging: product.product_packaging,
    }, params.q ?? "", searchBy) &&
    (!params.manufacturer || manufacturerOf(product)?.legal_name === params.manufacturer) &&
    (!params.supplier || product.product_suppliers.some(link => link.status === "active" && (Array.isArray(link.supplier) ? link.supplier[0]?.id : link.supplier?.id) === params.supplier)) &&
    (!params.brand || product.brand === params.brand) &&
    (!params.category || product.category === params.category));
  const grouped = Map.groupBy(filtered, product => manufacturerOf(product)?.legal_name ?? "Производитель не указан");

  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="products" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Фаза 1 · Номенклатура</p><h1>Товары</h1></div><div className="top-actions"><Link className="ghost button-link" href="/products/import">Импорт справочника</Link><span className="page-count">{filtered.length} из {products.length}</span></div></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}{params.success && <div className="login-success admin-message">{params.success}</div>}
      {error && <div className="setup-notice">Примените миграцию <strong>202609272000_product_catalog_classification.sql</strong> в Supabase.</div>}

      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Каталог</p><h2>Фильтры</h2></div></div>
        <form className="catalog-filters">
          <label className="catalog-search">Поиск товара<input name="q" defaultValue={params.q ?? ""} placeholder="Введите поисковое значение" /></label>
          <ProductSearchFieldSelect defaultValue={searchBy} />
          <label>Производитель<select name="manufacturer" defaultValue={params.manufacturer ?? ""}><option value="">Все производители</option>{manufacturerOptions.map(value=><option key={value}>{value}</option>)}</select></label>
          <label>Поставщик (завод)<select name="supplier" defaultValue={params.supplier ?? ""}><option value="">Все заводы</option>{(suppliers ?? []).map(value=><option value={value.id} key={value.id}>{value.legal_name}</option>)}</select></label>
          <label>Бренд<select name="brand" defaultValue={params.brand ?? ""}><option value="">Все бренды</option>{brandOptions.map(value=><option key={value}>{value}</option>)}</select></label>
          <label>Категория<select name="category" defaultValue={params.category ?? ""}><option value="">Все категории</option>{categoryOptions.map(value=><option key={value}>{value}</option>)}</select></label>
          <button className="primary" type="submit">Показать</button>
          {(params.q || params.manufacturer || params.supplier || params.brand || params.category) && <Link className="ghost button-link" href="/products">Сбросить</Link>}
        </form>
      </section>

      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Новая карточка</p><h2>Добавить товар</h2></div></div>
        <form action={createProduct} className="reference-form product-form">
          <label>Внутренний артикул<input name="internal_sku" required /></label><label>Название RU<input name="name_ru" required /></label>
          <label>Название EN<input name="name_en" /></label><label>Название KZ<input name="name_kk" /></label>
          <label>Завод-поставщик<select name="manufacturer_id" required defaultValue=""><option value="" disabled>Выберите</option>{(manufacturers ?? []).map(m=><option value={m.id} key={m.id}>{m.legal_name}</option>)}</select></label>
          <label>Бренд<input name="brand" /></label><label>Категория<select name="category" required defaultValue=""><option value="" disabled>Выберите</option>{PRODUCT_CATEGORIES.map(value=><option key={value}>{value}</option>)}</select></label>
          <label>Артикул поставщика<input name="supplier_sku" /></label><label>GTIN<input name="gtin" /></label>
          <label>ШК единицы<input name="unit_barcode" /></label><label>ШК короба<input name="box_barcode" /></label><label>ТН ВЭД<input name="hs_code" /></label>
          <label>Срок годности, дней<input name="shelf_life_days" type="number" min="1" /></label><label>Страна происхождения<input name="country_of_origin" maxLength={2} placeholder="FI" /></label>
          <label className="check-label"><input name="requires_sticker" type="checkbox" /> Нужна стикеровка</label><label className="check-label"><input name="requires_marking" type="checkbox" /> Нужен Честный знак</label>
          <button className="primary" type="submit" disabled={Boolean(error) || !manufacturers?.length}>Создать товар</button>
        </form>{!manufacturers?.length && !error && <p className="form-help">Сначала добавьте завод-поставщик в разделе «Поставщики».</p>}
      </section>

      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Реестр номенклатуры</p><h2>Папки товаров</h2></div></div><div className="catalog-tree">
        {[...grouped.entries()].map(([manufacturer, manufacturerProducts]) => <details className="catalog-folder" open={grouped.size === 1} key={manufacturer}>
          <summary><strong>{manufacturer}</strong><span>{manufacturerProducts.length} товаров</span></summary>
          {[...Map.groupBy(manufacturerProducts, product => product.brand || "Без бренда").entries()].map(([brand, brandProducts]) => <details className="catalog-subfolder" open={manufacturerProducts.length < 20} key={brand}>
            <summary><strong>{brand}</strong><span>{brandProducts.length}</span></summary>
            {[...Map.groupBy(brandProducts, product => product.category).entries()].map(([category, categoryProducts]) => <div className="catalog-category" key={category}>
              <h3>{category}<span>{categoryProducts.length}</span></h3>
              <div className="reference-list">{categoryProducts.map(product=>{const ids=Object.fromEntries(product.product_identifiers.map(i=>[i.identifier_type,i.value])); return <Link className="reference-row product-row counterparty-row-link" href={`/products/${product.id}`} key={product.id}><div><strong>{product.name.ru}</strong><small>{product.internal_sku} · {brand}</small></div><div className="tag-list">{ids.gtin && <span className="reference-tag">GTIN {ids.gtin}</span>}{ids.supplier_sku && <span className="reference-tag">Арт. {ids.supplier_sku}</span>}{product.requires_sticker && <span className="reference-tag accent">Стикер</span>}{product.requires_marking && <span className="reference-tag accent">ЧЗ</span>}</div><span className="reference-meta">{product.hs_code || "ТН ВЭД —"}{product.shelf_life_days ? ` · ${product.shelf_life_days} дн.`:""} · Открыть →</span></Link>})}</div>
            </div>)}
          </details>)}
        </details>)}
        {!error && !filtered.length && <p className="empty-state">По выбранным фильтрам товаров нет.</p>}
      </div></section>
    </section></main>;
}
