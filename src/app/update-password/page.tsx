import { updatePassword } from "./actions";

export default async function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="login-brand-mark">N</div>
        <p className="eyebrow">Безопасность Nexus-ARSEO</p>
        <h1>Новый пароль</h1>
        <p>Используйте отдельный пароль, который не применяется для почты или других сервисов.</p>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">Nexus-ARSEO</p>
          <h2>Задайте новый пароль</h2>
          <p className="login-intro">Не менее 12 символов.</p>
          {error && <div className="login-error">Пароли должны совпадать и содержать не менее 12 символов.</div>}
          <form action={updatePassword} className="login-form">
            <label htmlFor="password">Новый пароль</label>
            <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
            <label htmlFor="confirmation">Повторите пароль</label>
            <input id="confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={12} required />
            <button className="primary login-submit" type="submit">Сохранить пароль</button>
          </form>
        </div>
      </section>
    </main>
  );
}
