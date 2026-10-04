<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Google Sheets: обязательный режим только для чтения

- Google Таблицы ARSEO являются внешними источниками данных и считаются неизменяемыми.
- Запрещены любые операции записи: изменение ячеек и формул, форматирования, фильтров, комментариев, примечаний, листов, строк, столбцов, структуры книги и прав доступа.
- Интеграции разрешается настраивать только с минимальными правами чтения (`Viewer`, read-only scopes). Нельзя запрашивать или использовать права редактора.
- Nexus может только считывать данные и сохранять результат в собственной базе. Нормализация, проверки, сопоставления и исправления выполняются на стороне Nexus.
- Если чтение невозможно без выдачи прав записи, работу нужно остановить и сообщить об этом пользователю. Запись в Google Таблицу нельзя использовать даже как временное решение.
- Для книги `01 мастер калькулятор KZ` и листа `расчеты` это правило является безусловным.
