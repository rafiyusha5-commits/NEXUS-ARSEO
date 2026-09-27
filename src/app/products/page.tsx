import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import Link from "next/link";
import { createProduct } from "./actions";

type ProductRow = { id:string; internal_sku:string; name:Record<string,string>; brand:string|null; hs_code:string|null; shelf_life_days:number|null; requires_marking:boolean; requires_sticker:boolean; counterparties:{legal_name:string}[]; product_identifiers:{identifier_type:string;value:string}[] };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{error?:string;success?:string}> }) {
  const { profile, roles, supabase } = await requireUser();
  const params = await searchParams;
  const [{data: products,error},{data: manufacturers}] = await Promise.all([
    supabase.from("products").select("id, internal_sku, name, brand, hs_code, shelf_life_days, requires_marking, requires_sticker, counterparties!products_manufacturer_id_fkey(legal_name), product_identifiers(identifier_type, value)").order("internal_sku"),
    supabase.from("counterparties").select("id, legal_name").overlaps("roles", ["manufacturer","supplier"]).eq("status","active").order("legal_name"),
  ]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="products" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Фаза 1 · Номенклатура</p><h1>Товары</h1></div><div className="top-actions"><Link className="ghost button-link" href="/products/import">Импорт справочника</Link><span className="page-count">{products?.length ?? 0} товаров</span></div></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}{params.success && <div className="login-success admin-message">{params.success}</div>}
      {error && <div className="setup-notice">Примените миграцию <strong>202609270002_phase1_reference_data.sql</strong> в Supabase.</div>}
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Новая карточка</p><h2>Добавить товар</h2></div></div>
        <form action={createProduct} className="reference-form product-form">
          <label>Внутренний артикул<input name="internal_sku" required /></label><label>Название RU<input name="name_ru" required /></label>
          <label>Название EN<input name="name_en" /></label><label>Название KZ<input name="name_kk" /></label>
          <label>Производитель<select name="manufacturer_id" required defaultValue=""><option value="" disabled>Выберите</option>{(manufacturers ?? []).map(m=><option value={m.id} key={m.id}>{m.legal_name}</option>)}</select></label>
          <label>Бренд<input name="brand" /></label><label>Артикул поставщика<input name="supplier_sku" /></label><label>GTIN<input name="gtin" /></label>
          <label>ШК единицы<input name="unit_barcode" /></label><label>ШК короба<input name="box_barcode" /></label><label>ТН ВЭД<input name="hs_code" /></label>
          <label>Срок годности, дней<input name="shelf_life_days" type="number" min="1" /></label><label>Страна происхождения<input name="country_of_origin" maxLength={2} placeholder="FI" /></label>
          <label className="check-label"><input name="requires_sticker" type="checkbox" /> Нужна стикеровка</label><label className="check-label"><input name="requires_marking" type="checkbox" /> Нужен Честный знак</label>
          <button className="primary" type="submit" disabled={Boolean(error) || !manufacturers?.length}>Создать товар</button>
        </form>{!manufacturers?.length && !error && <p className="form-help">Сначала добавьте производителя или поставщика в разделе «Контрагенты».</p>}
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Реестр номенклатуры</p><h2>Карточки товаров</h2></div></div><div className="reference-list">
        {((products ?? []) as ProductRow[]).map(product=>{const ids=Object.fromEntries(product.product_identifiers.map(i=>[i.identifier_type,i.value])); return <article className="reference-row product-row" key={product.id}><div><strong>{product.internal_sku} · {product.name.ru}</strong><small>{product.counterparties[0]?.legal_name ?? "Производитель не указан"}{product.brand ? ` · ${product.brand}`:""}</small></div><div className="tag-list">{ids.gtin && <span className="reference-tag">GTIN {ids.gtin}</span>}{ids.supplier_sku && <span className="reference-tag">Арт. {ids.supplier_sku}</span>}{product.requires_sticker && <span className="reference-tag accent">Стикер</span>}{product.requires_marking && <span className="reference-tag accent">ЧЗ</span>}</div><span className="reference-meta">{product.hs_code || "ТН ВЭД —"}{product.shelf_life_days ? ` · ${product.shelf_life_days} дн.`:""}</span></article>})}
        {!error && !products?.length && <p className="empty-state">Товары ещё не добавлены.</p>}
      </div></section>
    </section></main>;
}
