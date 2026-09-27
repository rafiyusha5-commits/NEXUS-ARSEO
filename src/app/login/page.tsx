import Link from "next/link";
import { login } from "./actions";
import { hasSupabaseEnv } from "@/lib/supabase/config";

const messages: Record<string, string> = {
  configuration: "Подключение к базе данных ещё не настроено.",
  validation: "Проверьте электронную почту и пароль — не менее 8 символов.",
  credentials: "Неверная электронная почта или пароль.",
  disabled: "Учётная запись отключена. Обратитесь к администратору Nexus-ARSEO.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const configured = hasSupabaseEnv();

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="login-brand-mark">N</div>
        <p className="eyebrow">Внутренняя система ТОО ARSEO</p>
        <h1>Импорт и экспорт<br />в одном рабочем пространстве</h1>
        <p>Поставки, документы, склады и аналитика под единым контролем.</p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">Nexus-ARSEO</p>
          <h2>Вход в систему</h2>
          <p className="login-intro">Используйте корпоративную учётную запись.</p>

          {!configured && (
            <div className="login-notice">
              Демо-режим: Supabase будет подключён после создания проекта и добавления ключей.
            </div>
          )}
          {error && <div className="login-error">{messages[error] ?? "Не удалось выполнить вход."}</div>}

          <form action={login} className="login-form">
            <label htmlFor="email">Электронная почта</label>
            <input id="email" name="email" type="email" autoComplete="email" placeholder="name@arseo.kz" required />
            <label htmlFor="password">Пароль</label>
            <input id="password" name="password" type="password" autoComplete="current-password" minLength={8} required />
            <Link className="forgot-link" href="/forgot-password">Забыли пароль?</Link>
            <button className="primary login-submit" type="submit" disabled={!configured}>Войти</button>
          </form>

          {!configured && <Link className="demo-link" href="/">Открыть текущий демо-интерфейс →</Link>}
          <small className="login-help">Доступ выдаёт администратор Nexus-ARSEO.</small>
        </div>
      </section>
    </main>
  );
}
