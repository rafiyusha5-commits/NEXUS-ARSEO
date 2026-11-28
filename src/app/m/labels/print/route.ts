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

// Print of labels (202611280500): the labels are made if missing, the print is recorded, the PDF is returned. A form of
// this site only: a request from another origin is refused.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Запрос с другого сайта отклонён", { status: 403 });
  const { supabase } = await requireUser();
  const form = await request.formData();
  const targetType = form.get("target_type") === "batch" ? "batch" : "location";
  const ids = form.getAll("ids").filter((value): value is string => typeof value === "string" && uuid.test(value)).slice(0, 500);
  const formatValue = form.get("format") === "thermal" ? "thermal" : "a4";
  const copies = Math.min(Math.max(Number(form.get("copies")) || 1, 1), 100);
  const back = (message: string) => Response.redirect(new URL(`/m/labels?${targetType === "batch" ? "kind=batch&" : ""}error=${encodeURIComponent(message)}`, request.url), 303);
  if (!ids.length) return back("Выберите хотя бы одну этикетку");
  const { data: labels, error } = await supabase.rpc("ensure_scan_labels", { p_target_type: targetType, p_ids: ids });
  if (error || !Array.isArray(labels)) return back("Нет права печатать этикетки склада");
  const list = labels as Array<{ label_id: string; code: string; title: string; subtitle: string }>;
  const { error: printError } = await supabase.rpc("record_label_print", { p_label_ids: list.map(item => item.label_id), p_format: formatValue, p_copies: copies });
  if (printError) return back("Печать не записана — этикетки не выданы");
  const pdf = await renderLabelsPdf(list.map((item): LabelData => ({ code: item.code, title: item.title, subtitle: item.subtitle })), formatValue, copies,
    { regular: await font(request, "ubuntu-regular.ttf"), bold: await font(request, "ubuntu-bold.ttf") });
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="Nexus-labels.pdf"', "Cache-Control": "private, no-store" } });
}
