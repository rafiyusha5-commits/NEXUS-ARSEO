import { NextResponse, type NextRequest } from "next/server";
import { requirePortalUser } from "@/lib/auth/access";
import { DOCUMENT_BUCKET } from "@/lib/documents/files.ts";
import { isUuid } from "@/lib/documents/rules.ts";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requirePortalUser();
  let version = request.nextUrl.searchParams.get("version");
  const fallback = new URL(isUuid(id) ? `/portal/documents/${id}` : "/portal/documents", request.url);
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!isUuid(id) || (version !== null && !isUuid(version))) return NextResponse.redirect(fallback, { status: 303, headers });
  const { data: permissionData } = await supabase.rpc("my_external_document_permissions");
  if (!(permissionData as { download?: boolean } | null)?.download) {
    fallback.searchParams.set("error", "Скачивание не разрешено");
    return NextResponse.redirect(fallback, { status: 303, headers });
  }
  if (version === null) {
    const { data: published } = await supabase.rpc("my_external_document", { p_document_id: id });
    version = published?.[0]?.version_id ?? null;
    if (!version || !isUuid(version)) return NextResponse.redirect(fallback, { status: 303, headers });
  }
  const { data: rows } = await supabase.rpc("my_external_document_file", { p_document_id: id, p_version_id: version });
  const file = ((rows ?? []) as { storage_path: string; original_filename: string }[])[0];
  if (!file) { fallback.searchParams.set("error", "Файл недоступен"); return NextResponse.redirect(fallback, { status: 303, headers }); }
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(file.storage_path, 60, { download: file.original_filename });
  if (error || !data?.signedUrl) { fallback.searchParams.set("error", "Не удалось подготовить файл"); return NextResponse.redirect(fallback, { status: 303, headers }); }
  await supabase.rpc("record_external_document_access", { p_document_id: id, p_action: "download" });
  return NextResponse.redirect(data.signedUrl, { status: 303, headers });
}
