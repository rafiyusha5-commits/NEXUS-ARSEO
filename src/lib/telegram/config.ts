export function telegramConfig(env: Record<string, string | undefined> = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const username = env.TELEGRAM_BOT_USERNAME?.trim();
  const secret = env.TELEGRAM_WORKER_SECRET?.trim();
  if (env.TELEGRAM_ENABLED !== "true" || env.TELEGRAM_AUTH_ACKNOWLEDGED !== "true"
    || !token || !/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)
    || !username || !/^[A-Za-z0-9_]{5,32}$/.test(username)
    || !secret || !/^[a-f0-9]{64}$/.test(secret)) return null;
  return { token, username, secret };
}
