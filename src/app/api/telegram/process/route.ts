import { timingSafeEqual } from "node:crypto";
import { telegramConfig } from "@/lib/telegram/config.ts";
import { TelegramClient } from "@/lib/telegram/client.ts";
import { processTelegramUpdate } from "@/lib/telegram/processor";

export const maxDuration = 90;
export async function POST(request: Request) {
  const config = telegramConfig();
  const token = request.headers.get("x-nexus-telegram-worker") ?? "";
  if (!config || Buffer.byteLength(token) !== Buffer.byteLength(config.secret) || !timingSafeEqual(Buffer.from(token), Buffer.from(config.secret))) return new Response(null, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  if (Number(request.headers.get("content-length") ?? 0) > 16000) return new Response(null, { status: 413 });
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 16000) return new Response(null, { status: 413 });
    // Throws only before the update is claimed; then the local worker may deliver it again safely.
    await processTelegramUpdate(JSON.parse(text), new TelegramClient(config.token));
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
