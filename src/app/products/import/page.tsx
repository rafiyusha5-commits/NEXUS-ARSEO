import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { PurchasePriceSyncForm } from "./purchase-price-sync-form";
import { ReferenceImportForm } from "./reference-import-form";

const PERMISSIONS = ["products.create", "products.update", "prices.purchase.view"] as const;

export default async function ProductImportPage() {
  const { profile, roles, supabase, permissions: can } = await requirePageUser(PERMISSIONS);
  const {data:currencies}=can["products.update"]&&can["prices.purchase.view"] ? await supabase.from("currencies").select("code").eq("is_active",true).order("code") : {data:[]};
  const allowed = can["products.create"] && can["products.update"];

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="products" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Справочники</p><h1>Импорт контрагентов и товаров</h1></div>
          <Link className="ghost button-link" href="/products">Вернуться к товарам</Link>
        </header>
    <WorkflowHelp section="referenceImport"/>
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
