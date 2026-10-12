import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { PurchasePriceSyncForm } from "./purchase-price-sync-form";
import { ReferenceImportForm } from "./reference-import-form";

const PERMISSIONS = ["products.create", "products.update", "prices.purchase.view"] as const;

export default async function ProductImportPage() {
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, PERMISSIONS);
  const {data:currencies}=can["products.update"]&&can["prices.purchase.view"] ? await supabase.from("currencies").select("code").eq("is_active",true).order("code") : {data:[]};
  const allowed = can["products.create"] && can["products.update"];

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="products" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Фаза 1 · Справочники</p><h1>Импорт контрагентов и товаров</h1></div>
          <Link className="ghost button-link" href="/products">Вернуться к товарам</Link>
        </header>
        {allowed ? (
          <ReferenceImportForm />
        ) : (
          <section className="panel admin-section">
            <div className="empty-state">
              Для импорта справочника нужны права «Товары: создание» и «Товары: изменение». Обратитесь к администратору.
            </div>
          </section>
        )}
      {can["products.update"]&&can["prices.purchase.view"]&&<PurchasePriceSyncForm currencies={currencies??[]} />}
      </section>
    </main>
  );
}
