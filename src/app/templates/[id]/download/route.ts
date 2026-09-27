import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/access";
import { createTemplateDownloadUrl } from "@/lib/templates/operations.ts";
import { createTemplateGateway } from "@/lib/templates/supabase-gateway.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Redirects to a short-lived signed URL of a template file. Access requires
// templates.export and is re-checked by the Storage SELECT policy.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  const versionParam = request.nextUrl.searchParams.get("version");
  const versionId = versionParam && UUID.test(versionParam) ? versionParam : null;
  const result = await createTemplateDownloadUrl(createTemplateGateway(supabase, user.id), id, versionId);
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!result.ok) {
    const url = new URL(UUID.test(id) ? `/templates/${id}` : "/templates", request.url);
    url.searchParams.set("error", result.error);
    return NextResponse.redirect(url, { status: 303, headers });
  }
  return NextResponse.redirect(result.value, { status: 303, headers });
}
