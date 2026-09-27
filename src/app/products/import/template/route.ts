import { JSON_TEMPLATE, TEMPLATE_KINDS, type TemplateKind, csvTemplate } from "@/lib/reference-import/templates.ts";

// /products/import/template?kind=products|counterparties|identifiers|packaging|json
export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get("kind") ?? "products";
  if (kind === "json") {
    return new Response(JSON.stringify(JSON_TEMPLATE, null, 2) + "\n", {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="nexus-reference-import.json"',
        "Cache-Control": "no-store",
      },
    });
  }
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) return new Response("Unknown template", { status: 404 });
  return new Response(csvTemplate(kind as TemplateKind), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="nexus-${kind}-template.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
