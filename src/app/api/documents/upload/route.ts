import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { MAX_DOCUMENT_FILE_SIZE_BYTES } from "@/lib/documents/files";
import { registerDocumentWithFile, type OperationDeps, type UploadedFile } from "@/lib/documents/operations";
import { createDocumentGateway, randomHex, sha256Hex } from "@/lib/documents/supabase-gateway";
import { parseLinkValue, type DocumentLinkInput, type DocumentMetadata } from "@/lib/documents/rules";

const deps: OperationDeps = { newDocumentId: () => crypto.randomUUID(), randomHex, sha256Hex };
const text = (form: FormData, key: string) => { const value = form.get(key); return typeof value === "string" ? value.trim() : ""; };

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_FILE_SIZE_BYTES + 256_000) {
    return Response.json({ ok: false, error: "Файл превышает допустимый размер" }, { status: 413 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ ok: false, error: "Недопустимый источник запроса" }, { status: 403 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, error: "Сессия истекла. Войдите снова" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("is_active,user_type").eq("id", user.id).maybeSingle();
  if (!profile?.is_active || profile.user_type !== "employee") return Response.json({ ok: false, error: "Нет доступа" }, { status: 403 });

  let form: FormData;
  try { form = await request.formData(); } catch { return Response.json({ ok: false, error: "Не удалось прочитать файл" }, { status: 400 }); }
  const fileValue = form.get("file");
  if (!(fileValue instanceof File) || fileValue.size === 0) return Response.json({ ok: false, error: "Выберите файл" }, { status: 400 });
  const file: UploadedFile = { name: fileValue.name, size: fileValue.size, type: fileValue.type, bytes: async () => new Uint8Array(await fileValue.arrayBuffer()) };
  const metadata: DocumentMetadata = {
    document_type_id: text(form, "document_type_id"), title: text(form, "title"), document_number: null,
    description: null, document_date: null, valid_until: null, language: null, currency_id: null, amount: null,
  };
  const links: DocumentLinkInput[] = [];
  const linkValue = text(form, "link_primary");
  if (linkValue) {
    const link = parseLinkValue(linkValue, "primary");
    if (!link) return Response.json({ ok: false, error: "Некорректная связь с поставкой" }, { status: 400 });
    links.push(link);
  }
  const result = await registerDocumentWithFile(createDocumentGateway(supabase, user.id), deps, metadata, links, file);
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.code === "forbidden" ? 403 : result.code === "duplicate" ? 409 : 400 });
  revalidatePath("/documents");
  for (const link of links) if (link.entity_type === "shipment") revalidatePath(`/shipments/${link.entity_id}`);
  return Response.json({ ok: true, documentId: result.value });
}
