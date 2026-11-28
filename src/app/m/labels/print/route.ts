import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireUser } from "@/lib/auth/access";
import { renderLabelsPdf, type LabelData } from "@/lib/scan/labels-pdf";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function font(request: Request, name: string) {
  try { return new Uint8Array(await readFile(join(process.cwd(), "public", "fonts", name))); }
  catch {
    const response = await fetch(new URL(`/fonts/${name}`, request.url));
    if (!response.ok) throw new Error("FONT_UNAVAILABLE");
    return new Uint8Array(await response.arrayBuffer());
  }
}

// Print of labels (202611280500, 202611280700): the labels are made if missing, the print is recorded, the PDF is
// returned. A form of this site only: a request from another origin is refused.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Запрос с другого сайта отклонён", { status: 403 });
  const { supabase } = await requireUser();
  const form = await request.formData();
  const kind = form.get("target_type");
  const targetType = kind === "batch" || kind === "expected_batch" ? kind : "location";
  const ids = form.getAll("ids").filter((value): value is string => typeof value === "string" && uuid.test(value)).slice(0, 500);
  const formatValue = form.get("format") === "thermal" ? "thermal" : "a4";
  const clamp = (value: FormDataEntryValue | null) => Math.min(Math.max(Math.trunc(Number(value)) || 1, 1), 100);
  const copies = clamp(form.get("copies"));
  // Labels of expected batches come from the page of a shipment, each batch with its own number of copies (202611280700).
  const returnTo = String(form.get("return_to") ?? "");
  const page = /^\/shipments\/[0-9a-f-]{36}\/batches$/i.test(returnTo) ? returnTo : `/m/labels${targetType === "batch" ? "?kind=batch" : ""}`;
  const back = (message: string) => Response.redirect(new URL(`${page}${page.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`, request.url), 303);
  if (!ids.length) return back("Выберите хотя бы одну этикетку");
  const { data: labels, error } = await supabase.rpc("ensure_scan_labels", { p_target_type: targetType, p_ids: ids });
  if (error || !Array.isArray(labels)) return back(targetType === "expected_batch" ? "Нет права печатать наклейки партий поставки" : "Нет права печатать этикетки склада");
  const list = labels as Array<{ label_id: string; code: string; title: string; subtitle: string; expected_batch_id: string | null }>;
  const copiesOf = (item: (typeof list)[number]) => targetType === "expected_batch" && item.expected_batch_id && form.has(`copies_${item.expected_batch_id}`)
    ? clamp(form.get(`copies_${item.expected_batch_id}`)) : copies;
  if (list.reduce((total, item) => total + copiesOf(item), 0) > 2000) return back("Не больше 2000 наклеек за одну печать");
  const groups = new Map<number, string[]>();
  for (const item of list) groups.set(copiesOf(item), [...(groups.get(copiesOf(item)) ?? []), item.label_id]);
  for (const [count, labelIds] of groups) {
    const { error: printError } = await supabase.rpc("record_label_print", { p_label_ids: labelIds, p_format: formatValue, p_copies: count });
    if (printError) return back("Печать не записана — этикетки не выданы");
  }
  const pdf = await renderLabelsPdf(list.flatMap((item): LabelData[] => Array.from({ length: copiesOf(item) }, () => ({ code: item.code, title: item.title, subtitle: item.subtitle }))),
    formatValue, 1, { regular: await font(request, "ubuntu-regular.ttf"), bold: await font(request, "ubuntu-bold.ttf") });
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="Nexus-labels.pdf"', "Cache-Control": "private, no-store" } });
}
