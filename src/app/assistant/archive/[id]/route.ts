import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions.ts";
import { DRIVE_ID, DRIVE_PERMISSIONS } from "@/lib/google/drive-readonly.ts";
import { driveArchive } from "@/lib/google/drive-server.ts";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireUser(); const { id } = await params;
  const permitted = async () => { const can = await loadPermissions(supabase, [...DRIVE_PERMISSIONS, "agent.use"]); return ([...DRIVE_PERMISSIONS, "agent.use"] as const).every(code => can[code]); };
  if (!DRIVE_ID.test(id) || !await permitted()) return new Response("Файл не найден", { status: 404 });
  try {
    const file = await driveArchive.download(id, AbortSignal.timeout(30000));
    if (!await permitted()) return new Response("Файл не найден", { status: 404 });
    return new Response(file.blob, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
  } catch { return new Response("Файл недоступен или превышает лимит 15 МБ", { status: 404 }); }
}
