# Nexus-ARSEO

Закрытая корпоративная система ТОО ARSEO для управления импортом, экспортом, логистикой, складом, документами и аналитикой.

## Пилот

Первый пилот строится на реальном проекте RVI Fazer (Leib4-x–Leib7-x). Рабочие документы и персональные данные не хранятся в GitHub.

## Локальный запуск

```bash
pnpm install
pnpm dev
```

Приложение откроется по адресу `http://localhost:3000`.

## Проверки

```bash
pnpm lint
pnpm build
```

## Supabase

Приложение использует Supabase для PostgreSQL, авторизации и будущего объектного хранилища документов.

1. Создайте `.env.local` по образцу `.env.example`.
2. Добавьте URL проекта и publishable key из Supabase.
3. Примените SQL-файлы из `supabase/migrations`.
4. Создайте первого сотрудника через Supabase Auth и назначьте ему роль администратора через SQL Editor.
5. Примените миграцию фазы 0, после чего пользователями и правами можно управлять из интерфейса Nexus.

Ключ `SUPABASE_SECRET_KEY` нужен только серверу для отправки приглашений сотрудникам. Его нельзя добавлять в клиентский код или GitHub. Старый `SUPABASE_SERVICE_ROLE_KEY` поддерживается как резервный вариант.

Без переменных Supabase проект запускается в демо-режиме, чтобы интерфейс можно было разрабатывать до подключения облачной базы.

## Документы

Модуль «Документы» хранит файлы в приватном Storage bucket `nexus-documents` (создаётся миграцией `202609271001_document_management.sql`), выдаёт их по временным ссылкам и не использует секретный ключ Supabase. Максимальный размер файла — 4 МБ. Применение миграции, проверка bucket, права и откат описаны в [`docs/documents-module.md`](docs/documents-module.md).

Шаблоны документов (с версиями файлов) и карты ввода/вывода товара описаны в [`docs/templates-listing-cards.md`](docs/templates-listing-cards.md); миграция `202609271700_document_templates_listing_cards.sql` применяется после всех предыдущих.

## Тесты

```bash
pnpm typecheck
pnpm test      # модульные тесты (Node test runner)
pnpm test:db   # миграции и RLS на локальном PostgreSQL (нужны initdb и pg_ctl)
```

## Стек

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- Vercel

Подробный состав пилота описан в [`docs/pilot-scope.md`](docs/pilot-scope.md).
