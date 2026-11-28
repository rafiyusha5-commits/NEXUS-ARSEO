import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireUser } from "@/lib/auth/access";
import { renderCountSheetPdf } from "@/lib/inventory/count-pdf";
import type { CountSheet } from "@/lib/inventory/counts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bundled Cyrillic font: from the public folder on disk, else over HTTP from the same site. */
async function font(request: Request, name: string) {
  try { return new Uint8Array(await readFile(join(process.cwd(), "public", "fonts", name))); }
  catch {
    const response = await fetch(new URL(`/fonts/${name}`, request.url));
    if (!response.ok) throw new Error("FONT_UNAVAILABLE");
    return new Uint8Array(await response.arrayBuffer());
  }
}

// A printed count sheet: empty rows per location for a blind count (no book quantity), the book for an open one, the
// lines to recount in the recount. The sheet function of the database decides what is in it.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) return new Response("Не найдено", { status: 404 });
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("inventory_count_sheet", { p_count_id: id });
  if (error || !data) return new Response("Нет доступа к инвентаризации", { status: 403 });
  const sheet = data as CountSheet;
  const pdf = await renderCountSheetPdf(sheet, { regular: await font(request, "ubuntu-regular.ttf"), bold: await font(request, "ubuntu-bold.ttf") });
  return new Response(new Uint8Array(pdf), { headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="Nexus-count-${encodeURIComponent(sheet.number)}.pdf"`, "Cache-Control": "private, no-store" } });
}
