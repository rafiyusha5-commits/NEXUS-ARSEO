import { getReadiness } from "@/lib/monitoring/runtime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    const result = await getReadiness();
    return Response.json({ status: result.ready ? "ok" : "unavailable" }, { status: result.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
