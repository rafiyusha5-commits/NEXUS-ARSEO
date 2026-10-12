"use client";
import { useActionState } from "react";
import { createTelegramLink } from "@/app/assistant/telegram/actions";

export function TelegramLink() {
  const [state, action, pending] = useActionState(createTelegramLink, { url: "", error: "" });
  return <div>
    <form action={action}><button type="submit" className="primary" disabled={pending}>{pending ? "Создаю ссылку…" : "Создать ссылку подключения"}</button></form>
    {state.error && <p className="login-error">{state.error}</p>}
    {state.url && <div className="setup-notice"><p>Ссылка действует 10 минут. Откройте бота и нажмите «Начать», затем вернитесь сюда и обновите страницу.</p><a className="primary button-link" href={state.url} target="_blank" rel="noreferrer">Открыть Telegram-бота</a></div>}
  </div>;
}
