// Server transport. Never expose upstream errors: their URL may contain the bot token.
// TELEGRAM_UNAVAILABLE means the outcome is unknown (no answer, timeout, 5xx, unreadable answer):
// a sendMessage may still have been delivered. TELEGRAM_REJECTED, _UNAUTHORIZED, _CONFLICT and
// _RATE_LIMIT are definite refusals: nothing was done.
export class TelegramError extends Error {
  readonly retryAfter: number;
  readonly code: "TELEGRAM_UNAVAILABLE" | "TELEGRAM_UNAUTHORIZED" | "TELEGRAM_CONFLICT" | "TELEGRAM_RATE_LIMIT" | "TELEGRAM_REJECTED";
  constructor(code: TelegramError["code"], retryAfter = 0) {
    super(code); this.code = code; this.retryAfter = retryAfter;
  }
}

export type TelegramMethod = "getMe" | "getUpdates" | "getWebhookInfo" | "sendMessage" | "sendChatAction" | "getFile" | "sendDocument";
/** The part of the client the message pipeline uses; tests substitute it. */
export type TelegramBot = Pick<TelegramClient, "call" | "downloadVoice">;

export class TelegramClient {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new TelegramError("TELEGRAM_UNAUTHORIZED");
    this.token = token; this.fetcher = fetcher;
  }

  async call(method: TelegramMethod, payload: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? (method === "getUpdates" ? 35000 : 12000));
    try {
      let form: FormData | undefined;
      if (method === "sendDocument") {
        if (!(payload.document instanceof Blob)) throw new TelegramError("TELEGRAM_REJECTED");
        form = new FormData();
        for (const [key, value] of Object.entries(payload)) {
          if (key === "document") form.append(key, value as Blob, "nexus-answer.txt");
          else if (typeof value === "string" || typeof value === "number") form.append(key, String(value));
        }
      }
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        headers: form ? undefined : { "Content-Type": "application/json" }, body: form ?? JSON.stringify(payload),
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
      // A 4xx answer is a definite refusal (chat not found, bot blocked); 5xx leaves the outcome open.
      if (response.status >= 400 && response.status < 500 && data.ok === false) throw new TelegramError("TELEGRAM_REJECTED");
      if (!response.ok || data.ok !== true) throw new TelegramError("TELEGRAM_UNAVAILABLE");
      return data.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError("TELEGRAM_UNAVAILABLE");
    }
  }

  async downloadVoice(path: string, signal?: AbortSignal): Promise<Response> {
    if (!/^voice\/[A-Za-z0-9_.-]+\.oga$|^voice\/[A-Za-z0-9_.-]+\.ogg$/.test(path)) throw new TelegramError("TELEGRAM_UNAVAILABLE");
    const timeout = AbortSignal.timeout(10000);
    try { return await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${path}`, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch { throw new TelegramError("TELEGRAM_UNAVAILABLE"); }
  }
}
