<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Google Drive и Google Sheets: обязательный режим только для чтения

- Все Google Таблицы, файлы и папки Google Drive, используемые проектом ARSEO, являются внешними источниками данных и считаются неизменяемыми.
- Запрещены любые операции записи в Google Sheets: изменение ячеек и формул, форматирования, фильтров, комментариев, примечаний, листов, строк, столбцов, структуры книги и прав доступа.
- Запрещены любые изменения в Google Drive: создание и загрузка файлов или папок, замена содержимого, редактирование, конвертация, переименование, перемещение, копирование, удаление, восстановление, добавление комментариев и изменение прав доступа или общего доступа.
- Интеграции разрешается настраивать только с минимальными правами чтения (`Viewer`, Google Drive/Sheets read-only scopes). Нельзя запрашивать или использовать права редактора.
- Nexus может только просматривать, скачивать и считывать исходные данные и сохранять результат в собственной базе или инфраструктуре Nexus. Нормализация, проверки, сопоставления и исправления выполняются только на стороне Nexus.
- Запрещено использовать Google Drive или Google Sheets для временных файлов, журналов синхронизации, отметок об обработке или обратной записи статусов.
- Если чтение невозможно без выдачи прав записи, работу нужно остановить и сообщить об этом пользователю. Запись в Google Drive или Google Sheets нельзя использовать даже как временное решение.
- Правило действует безусловно для всех текущих и будущих Google-источников этого проекта, включая книгу `01 мастер калькулятор KZ`, лист `расчеты` и содержащие документы папки Google Drive.
