// Server transport. Never expose upstream errors: their URL may contain the bot token.
export class TelegramError extends Error {
  readonly retryAfter: number;
  readonly code: "TELEGRAM_UNAVAILABLE" | "TELEGRAM_UNAUTHORIZED" | "TELEGRAM_CONFLICT" | "TELEGRAM_RATE_LIMIT";
  constructor(code: TelegramError["code"], retryAfter = 0) {
    super(code); this.code = code; this.retryAfter = retryAfter;
  }
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new TelegramError("TELEGRAM_UNAUTHORIZED");
    this.token = token; this.fetcher = fetcher;
  }

  async call(method: "getMe" | "getUpdates" | "getWebhookInfo" | "sendMessage" | "sendChatAction" | "getFile", payload: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(method === "getUpdates" ? 35000 : 12000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (response.status === 401) throw new TelegramError("TELEGRAM_UNAUTHORIZED");
      if (response.status === 409) throw new TelegramError("TELEGRAM_CONFLICT");
      // Bot API results are bounded by getUpdates limit; message and attachment bodies aren't downloaded.
      const text = await response.text();
      if (text.length > 2_000_000) throw new TelegramError("TELEGRAM_UNAVAILABLE");
      const data = JSON.parse(text) as { ok?: boolean; result?: unknown; parameters?: { retry_after?: unknown } };
      if (response.status === 429) {
        const seconds = Number(data.parameters?.retry_after);
        throw new TelegramError("TELEGRAM_RATE_LIMIT", Number.isFinite(seconds) ? Math.min(300, Math.max(1, seconds)) : 10);
      }
      if (!response.ok || data.ok !== true) throw new TelegramError("TELEGRAM_UNAVAILABLE");
      return data.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError("TELEGRAM_UNAVAILABLE");
    }
  }

  async downloadVoice(path: string): Promise<Response> {
    if (!/^voice\/[A-Za-z0-9_.-]+\.oga$|^voice\/[A-Za-z0-9_.-]+\.ogg$/.test(path)) throw new TelegramError("TELEGRAM_UNAVAILABLE");
    try { return await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${path}`, { redirect: "error", signal: AbortSignal.timeout(10000) }); }
    catch { throw new TelegramError("TELEGRAM_UNAVAILABLE"); }
  }
}
