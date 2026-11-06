import { DocumentActions } from "@/components/documents/document-actions";
import { loadDocumentActions } from "@/lib/documents/load-actions";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import { allocationUuid, type ExactAllocationContext } from "@/lib/finance/exact-allocation";
import { ExactAllocationForm } from "./form";

export default async function AllocationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ currency?: string; source?: string }> }) {
  const { id } = await params, query = await searchParams;
  if (!allocationUuid.test(id)) notFound();
  const { profile, roles, supabase } = await requireUser();
  const [{ data: currencies }, { data: expense }, { data: permissions }] = await Promise.all([
    supabase.from("currencies").select("id,code").eq("is_active", true).order("code"),
    supabase.from("expenses").select("shipment_id,document_id").eq("id", id).maybeSingle(),
    supabase.rpc("my_permissions", { p_codes: ["costing.calculate", "finance.confirm"] }),
  ]);
  if (!expense?.shipment_id) notFound();
  const currency = query.currency ?? currencies?.find(c => c.code === "KZT")?.id ?? "";
  const source = query.source === "none" ? null : query.source ?? expense.document_id;
  if (!allocationUuid.test(currency) || (source && !allocationUuid.test(source))) notFound();
  const { data, error } = await supabase.rpc("exact_expense_allocation_context", { p_expense_id: id, p_currency_id: currency, p_source_document_id: source });
  const c = data as ExactAllocationContext | null;
  const documentActions = await loadDocumentActions(supabase, [c?.source_document_id, ...(c?.history ?? []).map(row => row.source_document_id)]);
  const actions = new Set<string>((permissions ?? []) as string[]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="finance"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Расходы поставки</p><h1>Точное распределение</h1></div></header>
    <a href={`/finance?shipment=${expense.shipment_id}`}>Вернуться к расходам и себестоимости</a>
    {error && <p role="alert" className="login-error">{ruleViolationMessage(error)}</p>}
    {c && <><section className="panel admin-section"><h2>{c.shipment_number} · {c.amount} {c.currency}</h2><p>{c.notes}</p>
      <p>Распределяемая сумма: <strong>{c.total} {c.target_currency}</strong>. Сохранение заменяет прежнее распределение этого расхода и сохраняет его историю.</p>
      <form className="reference-form" method="get"><label>Валюта распределения<select name="currency" defaultValue={currency}>{currencies?.map(x => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label>
        <label>Документ-основание<select name="source" defaultValue={source ?? "none"}><option value="none">Основание указано в пояснении</option>{c.sources.map(d => <option key={d.id} value={d.id}>{d.title} · версия {d.current_version}</option>)}</select></label><button className="secondary">Выбрать источник</button></form>
      {c.source_document_id && <DocumentActions document={documentActions[c.source_document_id]} version={c.source_version}/>}
      <p className="form-help">Можно выбрать только доступный документ, связанный с этой поставкой или её автомобилем. После смены источника суммы нужно проверить заново.</p>
      <p>Источник: {c.source_title ? `${c.source_title}, версия ${c.source_version}` : "пояснение сотрудника"}.</p>
      <ExactAllocationForm key={`${id}/${currency}/${source}`} context={c} requestId={randomUUID()} canSave={actions.has("costing.calculate") && (c.status !== "draft" || actions.has("finance.confirm"))}/>
    </section><section className="panel admin-section"><h2>История распределений</h2>{!c.history.length && <p>Сохранённых редакций пока нет.</p>}{c.history.map(h => <article key={h.id} className="reference-row reference-row-stack"><strong>{h.author} · {new Date(h.at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}</strong><p>{h.basis_note}</p>{h.source_document_id && <><small>Документ · версия {h.source_version ?? "не указана"}</small><DocumentActions document={documentActions[h.source_document_id]} version={h.source_version}/></>}<div>{h.lines.map(l => <p key={l.item_id}>{l.sku}: {l.amount} {h.currency}</p>)}</div></article>)}</section></>}
  </section></main>;
}
