import { timingSafeEqual } from "node:crypto";
import { telegramConfig } from "@/lib/telegram/config.ts";
import { TelegramClient } from "@/lib/telegram/client.ts";
import { reachabilityFetch, sendTelegramNotifications, telegramLinkBase } from "@/lib/telegram/notifications.ts";
import { serverClient } from "@/lib/telegram/processor";

// Called by the local bot worker (scripts/telegram-poll.mjs) between polls: sends due notifications to linked
// chats. Same secret as the message route; no new service and no public endpoint without the secret.
export const maxDuration = 60;
export async function POST(request: Request) {
  const config = telegramConfig();
  const token = request.headers.get("x-nexus-telegram-worker") ?? "";
  if (!config || Buffer.byteLength(token) !== Buffer.byteLength(config.secret) || !timingSafeEqual(Buffer.from(token), Buffer.from(config.secret))) return new Response(null, { status: 403 });
  const admin = serverClient();
  if (!admin) return Response.json({ ok: false }, { status: 503 });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await admin.rpc(name, args);
    if (response.error) throw new Error("TELEGRAM_DATABASE_UNAVAILABLE");
    return response.data;
  };
  try {
    const reach = reachabilityFetch();
    const result = await sendTelegramNotifications({ rpc, bot: new TelegramClient(config.token, reach.fetch), baseUrl: telegramLinkBase(process.env.NEXUS_PUBLIC_URL), unreachable: reach.unreachable });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
