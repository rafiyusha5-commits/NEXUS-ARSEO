# Ссылки в письмах входа: приглашение и восстановление пароля

Приглашение сотрудника отправляет сервер Nexus административным ключом (`inviteUserByEmail`). Такое письмо не может
использовать вход по коду PKCE: стандартная ссылка Supabase возвращает сотрудника в Nexus с ключом после `#`, который
сервер не видит, и вход не открывался. Поэтому ссылки писем строятся с одноразовым ключом `token_hash`, а
`/auth/callback` открывает по нему сессию (`verifyOtp`) и ведёт приглашённого и восстанавливающего пароль на
«Задать пароль» (`/update-password`). Использованная или просроченная ссылка ведёт на вход с подсказкой запросить
новую через «Забыли пароль?».

## Шаблоны писем в Supabase

Supabase → Authentication → Emails → Templates. В шаблонах **Invite user** и **Reset password** ссылка должна быть такой
(остальной текст письма — любой):

| Шаблон | Ссылка (`href`) |
|---|---|
| Invite user | `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite` |
| Reset password | `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery` |

Пример тела письма-приглашения:

```html
<h2>Приглашение в Nexus ARSEO</h2>
<p>Вас пригласили в рабочее пространство Nexus. Перейдите по ссылке и задайте пароль:</p>
<p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite">Принять приглашение</a></p>
```

## Настройки, без которых письма не работают

- Supabase → Authentication → URL Configuration: **Site URL** — рабочий адрес Nexus; в **Redirect URLs** — он же с `/**`
  (и `http://localhost:3000/**` для локальной копии).
- Supabase → Authentication → Emails → SMTP Settings: своя почта для отправки. Встроенная почта Supabase шлёт письма
  только участникам проекта Supabase и несколько в час.
- Сервер Nexus: `APP_ORIGIN` — рабочий адрес Nexus без пути. Без него в рабочей среде приглашение и восстановление
  пароля останавливаются до обращения к Supabase.

Проверки: `tests/auth/email-links.test.ts`.
