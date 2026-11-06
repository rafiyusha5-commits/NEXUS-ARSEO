import { loadDocumentActions } from "@/lib/documents/load-actions";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth/access";
import { AppSidebar } from "@/components/app-sidebar";
import { HistoricalPreparation } from "@/components/documents/historical-preparation";
import { loadPermissions } from "@/lib/permissions";
import { selectAll } from "@/lib/supabase/select-all";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { shipmentDrive } from "@/lib/google/drive-server";
import { isUuid } from "@/lib/documents/rules";
import { usableSourceContext } from "@/lib/document-extraction/source-context";
import { preparationSourceValues, type PreparationChoice, type PreparationInput, type PreparationSource } from "@/lib/shipments/historical-preparation";
import { saveHistoricalPreparation } from "./actions";

export default async function HistoricalPreparationPage({ searchParams }: { searchParams: Promise<{ shipment?: string; draft?: string; saved?: string; error?: string }> }) {
  const { supabase, profile, roles } = await requireUser();
  const params = await searchParams;
  const required = ["shipments.view", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;
  const permissions = await loadPermissions(supabase, required);
  const allowed = required.every(p => permissions[p]);
  let error = !allowed, folderName = "", checkedAt: string | null = null;
  let choices: PreparationChoice[] = [], revision = 0, prepareNew = false;
  let drafts: { id: string; source_shipment_id: string; updated_at: string }[] = [];
  let shipments: { id: string; shipment_number: string }[] = [];
  let input: PreparationInput | null = null;
  let changed = false;
  const id = params.draft && isUuid(params.draft) ? params.draft : randomUUID();
  if (allowed) try {
    const db = await shipmentDriveGateway(supabase);
    const [shipmentsResult, draftsResult, foldersResult] = await Promise.all([
      selectAll((from, to) => supabase.from("shipments").select("id,shipment_number").order("id").range(from, to)),
      selectAll((from, to) => db.from("historical_shipment_drafts").select("id,source_shipment_id,updated_at").order("id").range(from, to)),
      selectAll((from, to) => db.from("shipment_drive_folders").select("shipment_id").order("shipment_id").range(from, to)),
    ]);
    if (shipmentsResult.error || draftsResult.error || foldersResult.error) throw new Error("unavailable");
    shipments = (shipmentsResult.data ?? []).filter(s => foldersResult.data?.some(f => f.shipment_id === s.id));
    drafts = draftsResult.data ?? [];
    if (params.shipment && isUuid(params.shipment) && shipments.some(s => s.id === params.shipment)) {
      const shipmentId = params.shipment;
      const binding = await db.from("shipment_drive_folders").select("folder_id,folder_name,checked_at").eq("shipment_id", shipmentId).single();
      if (binding.error || !binding.data) throw new Error("unavailable");
      await shipmentDrive().scopedReference(binding.data.folder_id, AbortSignal.timeout(12000));
      folderName = binding.data.folder_name; checkedAt = binding.data.checked_at;
      if (params.draft) {
        const draft = await db.from("historical_shipment_drafts").select("source_shipment_id,choices,revision,prepare_new").eq("id", id).single();
        if (draft.error || draft.data?.source_shipment_id !== shipmentId) throw new Error("unavailable");
        choices = draft.data.choices; revision = draft.data.revision; prepareNew = draft.data.prepare_new;
      }
      const [sources, transports, items] = await Promise.all([
        selectAll((from, to) => supabase.from("shipment_source_extractions").select("id,document_id,document_version_id,shipment_transport_id,status,updated_at,reviewed_at,source_kind,extracted_data,confirmed_data,document:documents(title,archived_at,status,current_version,versions:document_versions!document_versions_document_id_fkey(id,is_current,version_number),links:document_links(entity_type,entity_id,removed_at))").eq("shipment_id", shipmentId).order("id").range(from, to)),
        selectAll((from, to) => supabase.from("shipment_transports").select("id").eq("shipment_id", shipmentId).neq("status", "cancelled").order("sequence_no").order("id").range(from, to)),
        selectAll((from, to) => supabase.from("shipment_items").select("id,uom,shipment_transport_id,product:products(internal_sku,name,hs_code)").eq("shipment_id", shipmentId).order("id").range(from, to)),
      ]);
      if (sources.error || transports.error || items.error) throw new Error("unavailable");
      const transportIds = (transports.data ?? []).map(t => t.id);
      const currentSources = (sources.data as unknown as PreparationSource[] ?? []).filter(s => usableSourceContext(s, shipmentId, transportIds)).map(preparationSourceValues);
      // Do not serialize archived, stale, detached or RLS-hidden source records/IDs.
      changed = choices.some(c => !currentSources.some(s => s.id === c.id));
      choices = choices.filter(c => currentSources.some(s => s.id === c.id));
      input = { shipmentId, sources: currentSources, transportIds, choices, complete: Boolean(checkedAt), items: (items.data ?? []).map(item => ({ ...item, product: Array.isArray(item.product) ? item.product[0] ?? null : item.product })) };
    }
  } catch { error = true; input = null; folderName = ""; }
  const documentActions = await loadDocumentActions(supabase, (input?.sources ?? []).map(row => row.document_id));
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Исторические поставки</p><h1>Проект загрузки</h1></div><Link href="/shipments">К поставкам</Link></header>
    {error && <p role="alert">Проект или источники недоступны. Проверьте права, подключение и актуальность папки. Частичные данные не используются.</p>}
    {params.error && <p role="alert">{params.error === "changed" ? "Источники или проект изменились. Обновите данные и повторно проверьте назначения." : "Сохранение не подтверждено. Проверьте доступ и откройте сохранённый проект перед повтором."}</p>}
    {params.saved && !error && <p role="status">Черновик сохранён в Nexus. Учётные операции не выполнялись.</p>}
    {!error && <section className="panel admin-section"><h2>Выберите доступный источник</h2><form action="/shipments/prepare"><label>Папка, привязанная к поставке<select name="shipment" defaultValue={params.shipment ?? ""} required><option value="" disabled>Выберите поставку-источник</option>{shipments.map(s => <option key={s.id} value={s.id}>{s.shipment_number}</option>)}</select></label><button className="primary">Подготовить проект</button></form><p>Используется существующая привязка папки. Новую папку сначала подключите в разделе документов поставки. Выбор не запускает импорт, OCR или подтверждение.</p>
      <h3>Продолжить сохранённый проект</h3>{drafts.map(d => <p key={d.id}><Link href={`/shipments/prepare?shipment=${d.source_shipment_id}&draft=${d.id}`}>{shipments.find(s => s.id === d.source_shipment_id)?.shipment_number ?? "Проект"} · {new Date(d.updated_at).toLocaleString("ru-RU")}</Link></p>)}
    </section>}
    {input && <><section className="panel admin-section"><h2>{folderName}</h2><p>Последний сохранённый полный обход: {checkedAt ? new Date(checkedAt).toLocaleString("ru-RU") : "не выполнялся"}. Это не проверка каждого файла Drive в реальном времени.</p><Link href={`/shipments/${input.shipmentId}?tab=documents#drive-folder`}>Открыть существующее сопоставление папки и повторное сканирование</Link></section>{changed && <p role="status">Часть прежних источников недоступна или устарела. Данные скрыты, комплект требует повторной проверки.</p>}<HistoricalPreparation documentActions={documentActions} key={`${id}:${revision}`} input={input} id={id} revision={revision} prepareNew={prepareNew} save={saveHistoricalPreparation}/></>}
  </section></main>;
}
