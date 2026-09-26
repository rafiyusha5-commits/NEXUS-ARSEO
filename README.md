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
4. Создайте сотрудников через Supabase Auth и назначьте первую роль администратора через SQL Editor.

Без переменных Supabase проект запускается в демо-режиме, чтобы интерфейс можно было разрабатывать до подключения облачной базы.

## Стек

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- Vercel

Подробный состав пилота описан в [`docs/pilot-scope.md`](docs/pilot-scope.md).
