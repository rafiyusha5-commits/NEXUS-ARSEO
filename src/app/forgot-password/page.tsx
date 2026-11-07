import { PendingSubmitButton } from "@/components/pending-submit-button";
import Link from "next/link";
import { requestPasswordReset } from "./actions";
import { AuthBrandPanel, NexusWordmark } from "@/components/brand";

const errorMessages: Record<string, string> = {
  validation: "Введите корректный адрес электронной почты.",
  email_address_invalid: "Supabase отклонил этот адрес электронной почты.",
  email_address_not_authorized:
    "Встроенная почтовая служба Supabase не разрешает отправку на этот адрес. Нужно подключить корпоративную SMTP-почту.",
  over_email_send_rate_limit:
    "Достигнут лимит отправки писем Supabase. Подождите около часа или подключите корпоративную SMTP-почту.",
  over_request_rate_limit:
    "Слишком много запросов за короткое время. Подождите несколько минут и повторите попытку.",
  request_timeout:
    "Supabase не ответил вовремя. Подождите несколько минут и повторите попытку.",
  send: "Не удалось отправить письмо. Причина записана в журнале приложения.",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await searchParams;

  return (
    <main className="login-page">
      <AuthBrandPanel title={<>Восстановление<br />доступа</>} text="Ссылка для смены пароля придёт только на корпоративную почту сотрудника." />
      <section className="login-panel">
        <div className="login-card">
          <NexusWordmark className="login-wordmark" />
          <h2>Забыли пароль?</h2>
          <p className="login-intro">Введите адрес вашей учётной записи.</p>
          {sent === "1" && <div className="login-success">Письмо отправлено. Откройте ссылку в нём на этом компьютере.</div>}
          {error && (
            <div className="login-error">
              {errorMessages[error] ?? errorMessages.send}
            </div>
          )}
          {!sent && (
            <form action={requestPasswordReset} className="login-form">
              <label htmlFor="email">Электронная почта</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
              <PendingSubmitButton pendingText="Выполняем…" className="primary login-submit" type="submit">Отправить ссылку</PendingSubmitButton>
            </form>
          )}
          <Link className="back-link" href="/login">← Вернуться ко входу</Link>
        </div>
      </section>
    </main>
  );
}
