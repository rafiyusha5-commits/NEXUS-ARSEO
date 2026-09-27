import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/access";
import { createDocumentDownloadUrl } from "@/lib/documents/operations.ts";
import { isUuid } from "@/lib/documents/rules.ts";
import { createDocumentGateway } from "@/lib/documents/supabase-gateway.ts";

// Redirects to a short-lived signed URL of a private Storage object. Access is checked
// by documents.view, by RLS on document_versions and by the Storage SELECT policy.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  const versionParam = request.nextUrl.searchParams.get("version");
  const versionId = versionParam && isUuid(versionParam) ? versionParam : null;

  const result = await createDocumentDownloadUrl(createDocumentGateway(supabase, user.id), id, versionId);
  const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

  if (!result.ok) {
    const target = isUuid(id) ? `/documents/${id}` : "/documents";
    const url = new URL(target, request.url);
    url.searchParams.set("error", result.error);
    return NextResponse.redirect(url, { status: 303, headers: noStore });
  }
  return NextResponse.redirect(result.value, { status: 303, headers: noStore });
}
