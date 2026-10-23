import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/access";
import { createXlsx, type XlsxCell } from "@/lib/xlsx";
import { loadShipmentReport, localizedName, one, type ReportReceiptItem } from "@/lib/shipment-report";
import { loadPermissions } from "@/lib/permissions";
import { loadShipmentOutcome } from "@/lib/shipment-outcome";
import { outcomeWorkbookSheets } from "@/lib/shipment-outcome-workbook";

const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "";
const dateTime = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle:"medium", timeStyle:"short" }).format(new Date(value)) : "";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["prices.purchase.view", "inventory.view", "products.view", "sales.view", "costing.view", "documents.view"] as const);
  const granted = new Set(Object.keys(permissions).filter((key) => permissions[key as keyof typeof permissions]));
  const report = await loadShipmentReport(supabase, id, granted);
  if (!report) return NextResponse.json({ error: "Поставка не найдена" }, { status: 404 });
  const outcome = await loadShipmentOutcome(supabase, id, report.items.map((item) => item.id), granted);
  const supplier = one(report.shipment.supplier);
  const customer = one(report.shipment.customer);
  const route = one(report.shipment.route);
  const summary: XlsxCell[][] = [
    ["Показатель", "Значение"], ["Номер поставки", report.shipment.shipment_number], ["Проект", report.shipment.project_code],
    ["Статус", report.shipment.status], ["Поставщик", supplier?.short_name || supplier?.legal_name], ["Клиент", customer?.short_name || customer?.legal_name],
    ["Маршрут", localizedName(route?.name)], ["Плановое прибытие", date(report.shipment.planned_arrival_date)],
    ["Заказано", report.totals.ordered], ["Принято", report.totals.accepted], ["По партиям", report.totals.batches],
    ["По движениям", report.totals.movements], ["Контроль остатков", !report.totals.hasReceipt ? "Ожидает приёмки" : report.totals.reconciled ? "Сходится" : "Есть расхождение"],
  ];
  const itemHeader: XlsxCell[] = ["Артикул", "Товар", "Бренд", "Автомобиль", "Ед.", "Заказано", "Подтверждено", "Отгружено", "Принято", "Расхождение", "Причина"];
  if (report.canViewPrices) itemHeader.push("Цена");
  const itemRows = report.items.map((item) => { const product = one(item.product); const transport = one(item.transport); const row: XlsxCell[] = [product?.internal_sku, localizedName(product?.name), product?.brand, transport?.sequence_no, item.uom, Number(item.ordered_quantity), item.confirmed_quantity == null ? null : Number(item.confirmed_quantity), item.shipped_quantity == null ? null : Number(item.shipped_quantity), item.accepted, item.discrepancy, item.discrepancy_reason]; if (report.canViewPrices) row.push(item.unit_price == null ? null : Number(item.unit_price)); return row; });
  const stageRows: XlsxCell[][] = [["№", "Этап", "Статус", "Начало", "Завершение", "Причина", "Исполнитель"], ...[...report.stages].sort((a,b) => (one(a.stage)?.sequence_order ?? 0) - (one(b.stage)?.sequence_order ?? 0)).map((run) => { const stage = one(run.stage); return [stage?.sequence_order, localizedName(stage?.name), run.status, dateTime(run.started_at), dateTime(run.completed_at), run.status_reason, run.performed_by_name]; })];
  const batchRows: XlsxCell[][] = [["Автомобиль", "Партия", "Производство", "Срок годности", "Ожидалось", "Принято", "Повреждено", "Недостача", "Излишек", "Причина", "Исполнитель"], ...report.receipts.flatMap((receipt) => (receipt.items ?? []).map((item: ReportReceiptItem) => { const batch = one(item.batch); return [one(receipt.transport)?.sequence_no, batch?.batch_number, date(batch?.manufacture_date), date(batch?.expiry_date), Number(item.expected_quantity), Number(item.accepted_quantity), Number(item.damaged_quantity), Number(item.shortage_quantity), Number(item.overage_quantity), item.discrepancy_reason, receipt.performed_by_name]; }))];
  const documentRows: XlsxCell[][] = [["Тип", "Название", "Номер", "Дата", "Статус", "Версия"], ...report.documents.map((document) => [one(document.type)?.name_ru || one(document.type)?.code, document.title, document.document_number, date(document.document_date), document.status, document.current_version]), ...report.missingDocuments.map(({ requirement, transport }) => [one(requirement.type)?.name_ru || one(requirement.type)?.code, transport ? `ОБЯЗАТЕЛЬНЫЙ ДОКУМЕНТ ОТСУТСТВУЕТ · автомобиль №${transport.sequence_no}` : "ОБЯЗАТЕЛЬНЫЙ ДОКУМЕНТ ОТСУТСТВУЕТ", "", "", "missing", ""])];
  const taskRows: XlsxCell[][] = [["Задача", "Статус", "Приоритет", "Срок", "Исполнитель"], ...report.tasks.map((task) => [task.title, task.status, task.priority, dateTime(task.due_at), one(task.assignee)?.full_name])];
  const outcomeSheets = outcomeWorkbookSheets(outcome, report.items);
  const file = createXlsx([{ name:"Сводка", rows:summary }, { name:"Позиции", rows:[itemHeader, ...itemRows] }, { name:"Этапы", rows:stageRows }, { name:"Партии", rows:batchRows }, { name:"Документы", rows:documentRows }, { name:"Задачи", rows:taskRows }, ...outcomeSheets]);
  const fileName = `shipment-${report.shipment.shipment_number || id}.xlsx`.replace(/[^A-Za-z0-9._-]/g, "-");
  return new Response(new Uint8Array(file), { headers: { "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition":`attachment; filename="${fileName}"`, "Cache-Control":"private, no-store" } });
}
