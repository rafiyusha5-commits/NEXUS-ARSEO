import Link from "next/link";
import { requestPasswordReset } from "./actions";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await searchParams;

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="login-brand-mark">N</div>
        <p className="eyebrow">Безопасность Nexus-ARSEO</p>
        <h1>Восстановление<br />доступа</h1>
        <p>Ссылка для смены пароля придёт только на корпоративную почту сотрудника.</p>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">Nexus-ARSEO</p>
          <h2>Забыли пароль?</h2>
          <p className="login-intro">Введите адрес вашей учётной записи.</p>
          {sent === "1" && <div className="login-success">Письмо отправлено. Откройте ссылку в нём на этом компьютере.</div>}
          {error && <div className="login-error">Не удалось отправить письмо. Проверьте адрес и повторите позже.</div>}
          {!sent && (
            <form action={requestPasswordReset} className="login-form">
              <label htmlFor="email">Электронная почта</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
              <button className="primary login-submit" type="submit">Отправить ссылку</button>
            </form>
          )}
          <Link className="back-link" href="/login">← Вернуться ко входу</Link>
        </div>
      </section>
    </main>
  );
}
