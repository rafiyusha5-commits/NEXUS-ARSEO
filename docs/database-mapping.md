# Соответствие логической модели и базы данных

Статус документа: черновик. Показывает, в какой физической таблице Supabase живёт каждая логическая сущность из [`data-model.md`](./data-model.md), реализована ли она, в какой фазе ([`mvp-implementation-plan.md`](./mvp-implementation-plan.md)) создаётся, откуда берутся данные и какие нужны ограничения доступа и аудит.

Все таблицы — в схеме `public`, кроме `auth.users` (управляет Supabase) и служебных функций в схеме `private`.

## Обозначения

### Источник данных

| Код | Источник |
|---|---|
| Nexus | ввод и расчёт в Nexus |
| Импорт | загрузка Excel / CSV в Nexus |
| Drive | Google Drive |
| Sheets | Google Sheets (файл «Калькулятор» и др.) |
| 1С УТ | 1С «Управление торговлей» (только чтение) |
| 1С БП | 1С «Бухгалтерия 8.3» (только чтение) |
| Auth | Supabase Auth |

«Главный источник» — чьи данные считаются верными при расхождении. 1С никогда не получает данных из Nexus.

### Профили RLS

| Код | Правило |
|---|---|
| **R-ACCESS** | таблицы доступа: чтение — сотрудники; изменение — право `roles.manage` (сейчас — роль `administrator`) |
| **R-REF** | справочник: чтение — сотрудники с `<модуль>.view`; создание и изменение — `<модуль>.create` / `update`; DELETE не выдаётся (архивирование через UPDATE) |
| **R-OPS** | операционные данные: как R-REF, плюс `scope` проверяется по строке (`assigned` — ответственный или исполнитель; `import` / `export` — тип поставки; `own_warehouse`; `no_prices` — через представление без цен) |
| **R-FIN** | финансовые данные: только `finance.*`, `costing.*`, `receivables.*`; сводный доступ (`summary`) — только через представления с агрегатами |
| **R-APPEND** | журнал: только INSERT (через функции `security definer`, триггеры или сервер); UPDATE и DELETE не выдаются никому |
| **R-SELF** | пользователь видит только свои строки (`recipient_user_id = auth.uid()`) |
| **R-SYNC** | запись — только серверные задания интеграций (ключ `service_role` на сервере, не в браузере); чтение — по `integrations.view` |
| **R-EXT** | дополнительно для внешних пользователей: только строки своего контрагента с `visibility = shared_with_counterparty`; только SELECT и INSERT; изменение статуса запрещено |
| **R-PD** | персональные данные (телефоны, данные водителей): ролям без доступа — представление без этих колонок |

Во всех профилях, кроме R-EXT, пользователь должен быть сотрудником (`profiles.user_type = employee`) и активным (`is_active = true`).

### Уровни аудита

| Код | Что пишется в `audit_log` |
|---|---|
| **A1** | создание, изменение (`before_data` / `after_data`), архивирование, смена статуса — триггером БД |
| **A2** | создание и смена статуса или ключевых полей |
| **A3** | таблица сама является журналом; в `audit_log` — только событие со ссылкой на запись |
| **A0** | не пишется (производные или массовые данные) |

---

## Сводная таблица

### Доступ и аудит

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Учётная запись | `auth.users` | да (Supabase) | 0 | profiles | Auth (создаёт администратор) | да (Supabase Auth) | управляет Supabase; самостоятельная регистрация отключена | журнал Supabase Auth |
| Профиль сотрудника / внешнего пользователя | `profiles` | да + расширение | 0 | auth.users, user_roles, counterparties | Nexus | да | R-ACCESS; внешний видит только себя | A1 |
| Роль | `app_roles` | да | 0 | role_permissions, user_roles | миграции, Nexus | да | R-ACCESS | A1 |
| Право | `permissions` | да | 0, дополняется в 1–8 | role_permissions | миграции | да | чтение — сотрудники; изменение — только миграцией | история миграций |
| Права роли | `role_permissions` | да + `scope` | 0 | app_roles, permissions | Nexus | да | R-ACCESS | A1 (обязательно) |
| Назначение роли | `user_roles` | да | 0 | profiles, app_roles | Nexus | да | R-ACCESS; пользователь видит свои | A1 (включая удаление) |
| Отдельное разрешение | `user_permission_overrides` | нет | 0 | profiles, permissions | Nexus | да | R-ACCESS; пользователь видит свои | A1 |
| Журнал действий | `audit_log` | да | 0 | profiles | Nexus (приложение, триггеры) | да | R-APPEND; чтение — см. «Реализованные таблицы» | A3 |

### Контрагенты, товары, склады, маршруты

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Контрагент | `counterparties` | нет | 1 | contacts, contracts, shipments, sales, profiles | Nexus, Импорт; с фазы 6 — сопоставление с 1С УТ | логистические и коммерческие атрибуты — да; реквизиты клиентов — **«Требует подтверждения ARSEO»** (И6) | R-REF (`customers` / `suppliers`) | A1 |
| Контакт контрагента | `counterparties_contacts` | нет | 1 | counterparties | Nexus | да | R-REF + R-PD | A1 |
| Договор | `contracts` | нет | 1 | counterparties, contract_terms, documents | Nexus, файл — Drive / Storage | да | R-REF; скрытие условий — И18 | A1 |
| Условие договора | `contract_terms` | нет | 1 | contracts, products | Nexus | да | R-REF, цены — `no_prices` | A1 |
| Товар | `products` | нет | 1 | identifiers, packaging, batches | Nexus, Импорт; 1С УТ — сопоставление (фаза 6) | да (карточка) | R-REF, цены — `no_prices` | A1 |
| Идентификатор товара | `product_identifiers` | нет | 1 | products, counterparties | Nexus, Импорт, документы поставщика | да | R-REF | A1 |
| Упаковка товара | `product_packaging` | нет | 1 | products | Nexus, данные производителя | да | R-REF | A1 |
| Склад | `warehouses` | нет | 1 | locations, balances | Nexus | да | R-REF | A1 |
| Зона / ячейка | `warehouse_locations` | нет | 1 | warehouses | Nexus | да | R-REF | A1 |
| Маршрут | `routes` | нет | 1 | shipments, process_templates | Nexus | да | R-REF | A1 |
| Перевозчик | `carriers` | нет | 1 | counterparties, vehicles | Nexus | да | R-REF | A1 |
| Автомобиль | `vehicles` | нет | 1 | carriers | Nexus | да | R-REF | A1 |
| Брокер | `brokers` | нет | 1 | counterparties | Nexus | да | R-REF | A1 |
| Валюта | `currencies` | нет | 1 | все денежные поля | миграция | да | чтение — сотрудники | A2 |

### Поставки, этапы, задачи

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Шаблон процесса | `process_templates` | нет | 2 | shipment_stages, routes | Nexus | да | чтение — сотрудники; изменение — `settings.update` | A1 |
| Этап шаблона | `shipment_stages` | нет | 2 | process_templates | Nexus | да | как `process_templates` | A1 |
| Поставка | `shipments` | нет | 2 | transports, items, stage_runs, documents | Nexus | да | R-OPS (`shipments`, `scope` по типу) | A1 |
| Перевозка | `shipment_transports` | нет | 2 | shipments, carriers, vehicles | Nexus | да | R-OPS + R-PD (водитель) | A1 |
| Позиция поставки (заказ поставщику) | `shipment_items` | нет | 2 | shipments, transports, products | Nexus, документы поставщика | да | R-OPS, цены — `no_prices` | A1 |
| Этап поставки | `shipment_stage_runs` | нет | 2 | shipments, shipment_stages | Nexus | да | R-OPS; статус — `shipments.change_status` | A2 + история |
| История этапов | `shipment_stage_history` | нет | 2 | stage_runs | Nexus | да | R-APPEND | A3 |
| Таможенное оформление | `customs_clearances` | нет | 2 | shipments, brokers | Nexus (данные брокера) | да | R-OPS | A1 |
| Согласование | `approvals` | нет | 2 | любые объекты | Nexus | да | чтение — инициатор, согласующий, владельцы модуля; решение — только согласующий | A1 |
| Задача | `tasks` | нет | 2 | любые объекты | Nexus | да | исполнитель, автор, руководители модуля | A2 |
| Комментарий | `comments` | нет | 2 | любые объекты | Nexus | да | по правам объекта; внешние — только `shared_with_counterparty` | A2 |
| Уведомление | `notifications` | нет | 2 | profiles | Nexus | да | R-SELF | A0 |
| Доставка уведомления | `notification_deliveries` | нет | 2 (email), 6 (WhatsApp) | notifications | Nexus (сервер) | да | R-SELF на чтение; запись — сервер | A0 |

### Документы и шаблоны

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Документ | `documents` | нет | 3 | versions, approvals, объекты | Nexus, Drive, внешние пользователи (фаза 8) | метаданные — да; файл — хранилище по М5 | R-OPS (`documents`) + R-EXT | A1 + выгрузки |
| Версия документа | `document_versions` | нет | 3 | documents | Nexus, Drive | метаданные — да | R-APPEND + R-EXT | A3 |
| Шаблон документа | `document_templates` | нет | 3 | documents | Nexus; файл — Drive / Storage | да | R-REF (`templates`) | A1 |
| Карта ввода / вывода | `product_listing_cards`, `product_listing_card_items` | нет | 3 | counterparties, products, documents | Nexus (автозаполнение из карточек) | да | R-OPS (`customers`) | A1 |

### Партии, остатки, продажи, стикеры

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Партия | `batches` | нет | 4 | products, shipments, balances | Nexus (приёмка) | да (серии, сроки, ОСГ) | R-OPS (`inventory`); себестоимость — R-FIN | A1 |
| Остаток | `inventory_balances` | нет | 4 | batches, warehouses | вычисляется из движений | по партиям — да; количественный учёт — сверка с 1С УТ (И4) | чтение — `inventory.view`; запись — только триггер | A0 |
| Движение | `inventory_movements` | нет | 4 | batches, warehouses, shipments, sales | Nexus | да (партии) | R-APPEND; создание — `inventory.create` | A3 |
| Резерв / блокировка | `inventory_reservations` | нет | 4 | batches, sale_items | Nexus | да | R-OPS | A1 |
| Клиентский заказ / продажа | `sales` | нет | 4 | sale_items, receivables | Nexus (пилот); 1С УТ — сверка (фаза 6) | **«Требует подтверждения ARSEO»** (И2) | R-OPS, суммы — R-FIN | A1 |
| Позиция продажи | `sale_items` | нет | 4 | sales, batches, guarantee_letters | Nexus | как `sales` | R-OPS; себестоимость — R-FIN | A1 |
| Гарантийное письмо | `guarantee_letters`, `guarantee_letter_items` | нет | 4 | sales, batches, documents | Nexus | да | R-OPS (`documents`); файл письма — R-EXT | A1 |
| Стикер | `sticker_templates` | нет | 4 | products, versions | Nexus | да | R-REF (`templates`) | A1 |
| Версия макета стикера | `sticker_template_versions` | нет | 4 | sticker_templates, documents | Nexus; файл — Drive / Storage | да | R-REF; согласование — `templates.approve` | A1 |
| Заказ стикеров | `sticker_orders`, `sticker_order_items` | нет | 4 | shipments, batches, versions | Nexus | да | R-OPS (`inventory`) | A1 |
| Заказ кодов маркировки | `marking_code_orders` | нет | 4 (экраны — по необходимости) | products, marking_codes | Nexus | да | R-OPS (`inventory`) | A1 |
| Код маркировки | `marking_codes` | нет | 4 | batches, orders | файл кодов («Честный знак» / партнёр) | да (в Nexus) | R-OPS; значения кодов не попадают в логи | A2 (пакетом) |

### Финансы

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Курс валюты | `exchange_rates` | нет | 5 | currencies, expenses | официальный источник, банк (ручной ввод или загрузка) | нет (внешний источник) | чтение — сотрудники; запись — `finance.manage` | A3 |
| Расход | `expenses` | нет | 5 | shipments, allocations, documents | Nexus, счета; 1С БП — сверка | да (для себестоимости) | R-FIN; черновики — логистика (`scope = assigned`) | A1 |
| Распределение расхода | `expense_allocations` | нет | 5 | expenses, batches | вычисляется | да | R-FIN (`costing`) | A1 |
| Дебиторская задолженность | `receivables` | нет | 5 | sales, counterparties | 1С (И10) | предположительно нет | R-FIN (`receivables`) | A2 |
| Оплата | `receivable_payments` | нет | 5 | receivables | 1С БП | предположительно нет | R-FIN | A2 |
| Прибыльность клиента | `client_profitability_snapshots` | нет | 5 | counterparties | вычисляется | да | R-FIN (`costing`) | A1 |
| Возврат клиента | `customer_returns`, `customer_return_items` | нет | 5 | sales, batches, guarantee_letters | Nexus | да | R-OPS; суммы — R-FIN | A1 |

### Интеграции

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Интеграция | `integrations` | нет | 6 (3 — если хранилище = Drive) | runs, mappings | Nexus | да | чтение — `integrations.view`; изменение — Адм | A1 |
| Запуск синхронизации | `synchronization_runs` | нет | 6 | integrations, errors | Nexus (сервер) | да | R-SYNC | A3 |
| Ошибка синхронизации | `synchronization_errors` | нет | 6 | runs | Nexus (сервер) | да | R-SYNC; разбор — владелец раздела | A2 |
| Сопоставление с внешней системой | `integration_mappings` | нет | 6 | любые сущности | Nexus | да | R-SYNC; ручное сопоставление — владелец раздела | A1 |

### Планирование

| Бизнес-наименование | Таблица | Реализована | Фаза | Главные связи | Источник | Главный — Nexus? | RLS | Аудит |
|---|---|---|---|---|---|---|---|---|
| Прогноз продаж (версия) | `forecasts`, `forecast_lines` | нет | 7 | products, counterparties, promo | Nexus; история продаж — 1С УТ; Импорт, Sheets | да | R-OPS (`forecasts`) | A1 (по версиям) |
| План закупок (версия) | `purchase_plans`, `purchase_plan_lines` | нет | 7 | forecasts, shipments | Nexus | да | R-OPS (`forecasts`) | A1 |
| Промо и распродажа | `promo_plans`, `promo_plan_items` | нет | 7 | counterparties, products, batches | Nexus | да | R-OPS (`forecasts`); бюджет — R-FIN | A1 |

Фаза 8 (кабинет клиента) новых таблиц не создаёт: она использует `profiles.user_type`, `profiles.counterparty_id`, роль `external_client`, `user_permission_overrides`, `documents.visibility` и политики R-EXT.

---

## Реализованные таблицы Supabase

Миграция `202609260001_identity_and_access.sql`. Реализованное не заменяется: ниже — как оно соотносится с логической моделью и чего не хватает.

### Переход от прежней версии документации

| Прежнее имя в документах | Реализованная таблица |
|---|---|
| `users` (с `password_hash`) | `auth.users` — пароли хранит Supabase Auth |
| `employees` | `profiles` |
| `roles` | `app_roles` |
| `employee_roles` | `user_roles` |
| `employee_roles.permissions_override` | `user_permission_overrides` (новая таблица) |
| `role_permissions.access_level` | `role_permissions.granted` + предлагаемый `scope` |
| `audit_log.actor_employee_id`, `before_state`, `after_state`, `occurred_at` | `actor_user_id`, `before_data`, `after_data`, `created_at` |
| коды `logistics_manager`, `system_admin` | `logistics_specialist`, `administrator` |
| поля `*_employee_id` в бизнес-таблицах | `*_user_id` → `profiles.id` |

### Таблица за таблицей

| Таблица | Колонки сейчас | Логическая сущность | Расхождения и предлагаемые расширения |
|---|---|---|---|
| `profiles` | id, full_name, job_title, locale (`ru`/`kk`/`en`), is_active, created_at, updated_at | профиль сотрудника и внешнего пользователя | добавить `user_type`, `counterparty_id`, `phone`, `whatsapp_phone`, `notification_preferences`, `primary_warehouse_id`, `deactivated_at`, `deactivated_by` |
| `app_roles` | id, code, name, description, is_system, is_enabled, created_at, updated_at | роль доступа | добавить `audience` (`internal` / `external`); в фазе 8 — роль `external_client` |
| `permissions` | id, code, module, action, name, description | право | добавить коды по разделам (фазы 0–8); существующие 12 кодов сохраняются |
| `role_permissions` | role_id, permission_id, granted | права роли | добавить `scope text[]`; заполнить матрицу для 8 ролей кроме `administrator` |
| `user_roles` | user_id, role_id, assigned_by, assigned_at | назначение роли | по решению П16 — `expires_at` |
| `audit_log` | id (bigint), actor_user_id, action, entity_type, entity_id (text), before_data, after_data, metadata, created_at | журнал | структура подходит; тип действия системы и `on_behalf_of` — в `metadata` |

### Текущие права и политики

| Таблица | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `app_roles` | все вошедшие, если роль включена | только `administrator` |
| `permissions` | все вошедшие | не выданы |
| `role_permissions` | все вошедшие | только `administrator` |
| `profiles` | все вошедшие — активные профили | UPDATE — только `administrator` |
| `user_roles` | свои назначения; все — `administrator` | только `administrator` |
| `audit_log` | свои записи; все — `administrator`, `director` | INSERT — только от своего имени (`actor_user_id = auth.uid()`); UPDATE и DELETE не выданы |

### Что нужно учесть до следующих фаз

1. **Внешние пользователи увидят сотрудников.** Политики SELECT на `profiles`, `app_roles`, `permissions`, `role_permissions` разрешают чтение любому вошедшему пользователю. До фазы 8 (желательно в фазе 0) ограничить их условием `user_type = employee`, а внешнему пользователю оставить только свой профиль.
2. **Тип нового пользователя.** Триггер `handle_new_user` создаёт профиль для любого пользователя Supabase Auth. Предложение: брать `user_type` из `raw_user_meta_data` при создании и не давать доступа пользователю без ролей. Если тип не задан, профиль будет считаться сотрудником — администратор должен проверять тип при создании внешнего пользователя.
3. **История уволенных сотрудников.** Политика показывает только активные профили, поэтому в истории (кто создал, кто согласовал) имена отключённых сотрудников станут пустыми. Нужно представление с `id` и `full_name` всех профилей для сотрудников.
4. **Проверка по правам, а не по ролям.** Сейчас политики вызывают `private.has_role('administrator')`. Для бизнес-таблиц нужна функция `private.has_permission(code, ...)`, которая учитывает `role_permissions.scope`, `user_permission_overrides`, `is_active` и `is_enabled`.
5. **Надёжность журнала.** Запись в `audit_log` сейчас делает клиент от своего имени, поэтому приложение может её пропустить. Для прав, статусов, движений и финансов писать журнал триггерами БД или функциями `security definer`. Системные события (без пользователя) пишет сервер: текущая политика требует `actor_user_id = auth.uid()`.
6. **Снятие ролей.** Удаление строки `user_roles` не оставляет следа — нужен триггер записи в `audit_log`.
7. **Чтение журнала.** Целевая матрица даёт полный доступ к журналу также `executive_director`, а руководителям — по своему разделу. Это требует новой политики (раздел 19 в `roles-permissions.md`).
8. **Управление ролями.** Сейчас только `administrator`. Расширение на `director` — после ответа на М12.
9. **Самостоятельная регистрация.** В настройках Supabase Auth регистрация должна быть отключена: пользователей создаёт администратор.
10. **Интерфейс показывает одну роль.** Главная страница берёт первую назначенную роль (`limit 1`). При нескольких ролях у пользователя это нужно учесть в экране профиля (фаза 0); на базу не влияет.
