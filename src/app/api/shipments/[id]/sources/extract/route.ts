import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { extractShipmentSources } from "@/lib/document-extraction/shipment-service";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { loadPermissions } from "@/lib/permissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ ok: false, error: "Некорректная поставка" }, { status: 400 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ ok: false, error: "Недопустимый источник запроса" }, { status: 403 });
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "documents.view", "shipments.view"] as const);
  if (!permissions["source_documents.extract"] || !permissions["documents.view"] || !permissions["shipments.view"]) {
    return Response.json({ ok: false, error: "Недостаточно прав для распознавания документов" }, { status: 403 });
  }
  try {
    const summary = await extractShipmentSources(supabase, id);
    revalidatePath(`/shipments/${id}`);
    return Response.json({ ok: true, summary });
  } catch (error) {
    return Response.json({ ok: false, error: publicErrorMessage(error, "Не удалось распознать документы.") }, { status: 400 });
  }
}
