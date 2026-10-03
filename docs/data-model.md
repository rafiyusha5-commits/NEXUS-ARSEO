# Логическая модель данных Nexus-ARSEO

Статус документа: черновик для реализации в Supabase (PostgreSQL). Документ описывает **логическую** модель: сущности, поля, связи, статусы, архивирование и аудит. SQL-миграций здесь нет.

Модель учитывает уже реализованную часть — миграцию [`supabase/migrations/202609260001_identity_and_access.sql`](../supabase/migrations/202609260001_identity_and_access.sql) и авторизацию через Supabase Auth. Реализованные таблицы не заменяются: для них описаны только предлагаемые расширения.

Связанные документы: [роли и права](./roles-permissions.md) · [процесс RVI](./process-rvi.md) · [соответствие таблицам и фазам](./database-mapping.md) · [план MVP](./mvp-implementation-plan.md) · [критерии приёмки](./mvp-acceptance-criteria.md) · [открытые вопросы](./open-questions.md).

Все допущения, которые ARSEO ещё не подтвердила, помечены **«Требует подтверждения ARSEO»**.

## Состояние реализации

| Отметка | Значение |
|---|---|
| **Реализовано** | таблица есть в миграции `202609260001_identity_and_access.sql` |
| **Расширение** | таблица реализована, предлагается добавить поля или ограничения отдельной миграцией |
| **Новая (фаза N)** | таблица ещё не создана; фаза — по [`mvp-implementation-plan.md`](./mvp-implementation-plan.md) |

---

## 0. Термины

Эти определения одинаковы во всех документах.

| Термин | Определение | Где хранится |
|---|---|---|
| **Сотрудник** | работник ARSEO с учётной записью в Nexus | `auth.users` + `profiles` (`user_type = employee`) |
| **Внешний пользователь** | представитель клиента, а в будущем брокера или перевозчика, с ограниченным доступом | `auth.users` + `profiles` (`user_type = external`, `counterparty_id`) |
| **Роль доступа** | набор прав в системе; не равна должности | `app_roles`, `user_roles` |
| **Должность** | запись в профиле сотрудника, на права не влияет | `profiles.job_title` |
| **Проект** | коммерческий код сделки, например Leib7-x. В пилоте один проект соответствует одной поставке — **«Требует подтверждения ARSEO»** | `shipments.project_code` |
| **Заказ поставщику** | согласованный перечень товаров, количеств и цен, который ARSEO заказывает у производителя или поставщика. Отдельной таблицы нет: это позиции поставки (`ordered_quantity`, `unit_price`) + согласование + документ заказа | `shipment_items`, `approvals`, `documents` |
| **Поставка** | сквозной процесс по одному заказу поставщику: от запроса до закрытия. Может ехать одним или несколькими автомобилями | `shipments` |
| **Перевозка** | один автомобиль или рейс внутри поставки (в пилоте их два) | `shipment_transports` |
| **Партия** | количество одного товара с одной серией производителя и одним сроком годности, принятое в рамках одной поставки | `batches` |
| **Серия** | номер серии (лота) производителя, указанный на упаковке | `batches.supplier_batch_number` |
| **ОСГ** | остаточный срок годности в процентах от полного срока. Формула — в разделе «Партии» | вычисляется из `batches` |
| **FEFO** | First Expired, First Out: сначала отгружается партия с ближайшим сроком годности | правило резервирования |
| **Клиентский заказ / продажа** | отгрузка товара клиенту с позициями по партиям | `sales`, `sale_items` |
| **Гарантийное письмо** | письмо клиенту, если ОСГ товара ниже условий клиента | `guarantee_letters` |
| **Карта ввода / вывода** | клиентская форма для ввода товара в ассортимент клиента или вывода из него | `product_listing_cards` |
| **Макет стикера** | согласованная версия содержимого и вида стикера для товара | `sticker_templates`, `sticker_template_versions` |

## 1. Общие принципы

- **Аутентификация — Supabase Auth.** Учётные записи хранятся в `auth.users` (схема `auth` управляется Supabase). Сотрудник входит по корпоративной почте и паролю; пароль задаётся и восстанавливается через Supabase Auth (страницы `/login`, `/forgot-password`, `/update-password`). В схеме `public` нет таблицы `users` и нет паролей или их хэшей.
- **Профиль.** Для каждой записи `auth.users` триггер `on_auth_user_created` создаёт строку `profiles` с тем же `id`. Все ссылки на людей в бизнес-таблицах ведут на `profiles.id` (поля `*_user_id`, `created_by`, `updated_by`).
- **Первичные ключи** — `id uuid` (`gen_random_uuid()`); исключение — `audit_log.id bigint identity` (уже реализовано).
- **Служебные поля** — `created_at timestamptz`, `updated_at timestamptz`, при необходимости `created_by`, `updated_by` → `profiles.id`.
- **Архивирование.** В реализованных таблицах используются `is_active` (`profiles`) и `is_enabled` (`app_roles`). В новых таблицах — `archived_at timestamptz` + `archived_by uuid → profiles.id`; пустое `archived_at` означает активную запись. Физическое удаление бизнес-данных не предусмотрено.
- **Журналы (append-only)**: `audit_log`, `inventory_movements`, `shipment_stage_history`, `exchange_rates`, `synchronization_runs`, `synchronization_errors`, `document_versions`. Записи не меняются и не удаляются; ошибки исправляются новой (сторнирующей) записью.
- **Статусы** хранятся как `text` с `check`-ограничением (так же, как `profiles.locale` в текущей миграции).
- **Срок хранения.** Документы и история хранятся ориентировочно 2–3 года. Точный срок и порядок удаления по его истечении — **«Требует подтверждения ARSEO»**.
- **Языки** — русский, английский, казахский (`ru`, `en`, `kk`; поле `profiles.locale` уже реализовано). Переводимые названия хранятся в `jsonb`-полях вида `{"ru": "...", "en": "...", "kk": "..."}`.
- **Валюты** — KZT, RUB, EUR. У каждой суммы есть `currency_id`; курсы (официальный и банковский) — в `exchange_rates`.
- **Полиморфные ссылки** (`entity_type` + `entity_id` в `audit_log`, `comments`, `notifications`, `approvals`, `documents`) не имеют FK в БД; целостность проверяет приложение.
- **Персональные данные** (телефоны, данные водителей) хранятся в минимальном объёме, доступ ограничен правами. В GitHub персональные данные не попадают.

### Файлы и документы

| Уровень | Что хранит | Состояние |
|---|---|---|
| Supabase / PostgreSQL | структурированные данные, метаданные документов, версии, связи, результаты проверки, согласования | целевое решение |
| Google Drive | действующий источник документов ARSEO на сегодня | используется |
| Google Drive или Supabase Storage | файлы, загружаемые и создаваемые в Nexus | **выбор не сделан** |

Основное хранилище файлов Nexus выбирается отдельно (см. [`open-questions.md`](./open-questions.md), вопрос М5). Поэтому модель поддерживает оба варианта: у версии документа есть `storage_provider` (`google_drive` или `supabase_storage`) и соответствующие ссылки (`external_file_id` или `storage_path`).

### Внешние пользователи

Внутренние сотрудники и внешние пользователи различаются полем `profiles.user_type`.

- Внешний пользователь привязан к контрагенту (`profiles.counterparty_id`) и видит только данные своего контрагента, явно открытые для внешнего доступа (`documents.visibility = shared_with_counterparty`).
- Клиенту по разрешению администратора можно открыть просмотр, загрузку и выгрузку документов. Менять статусы клиент не может.
- Позже такой же ограниченный доступ может понадобиться брокерам и перевозчикам.
- Подробности — в [`roles-permissions.md`](./roles-permissions.md), раздел «Внешние пользователи».

---

## 2. Доступ и аудит

### auth.users — Реализовано (Supabase Auth)

Учётная запись. Таблицей управляет Supabase; приложение не пишет в неё напрямую.

- **Используемые поля**: `id` (uuid, PK), `email` (корпоративная почта, логин), служебные поля Supabase (подтверждение почты, время входа, `raw_user_meta_data.full_name`).
- **Пароль** хранит и проверяет Supabase Auth. Минимальная длина: 8 символов при входе, 12 при смене (текущий код).
- **Создание**: администратор создаёт пользователя в Supabase Auth; триггер создаёт `profiles`. Самостоятельная регистрация должна быть отключена в настройках Supabase.
- **Архивирование**: учётная запись не удаляется, чтобы не терять историю (`profiles` удаляется каскадно вместе с `auth.users`). Доступ закрывается через `profiles.is_active = false` и, при необходимости, блокировку пользователя в Supabase Auth.
- **audit_log**: вход и выход фиксирует журнал Supabase Auth. Создание, блокировка и разблокировка пользователя пишутся в `audit_log` как действия над `profiles`.

### profiles — Расширение

Профиль сотрудника или внешнего пользователя, 1–1 с `auth.users`.

**Реализованные поля**

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK, FK → `auth.users.id` (on delete cascade) |
| full_name | text | да | ФИО |
| job_title | text | нет | должность (например, «Старший менеджер по логистике») |
| locale | text | да | `ru` / `kk` / `en`, по умолчанию `ru` |
| is_active | boolean | да | активен ли доступ |
| created_at / updated_at | timestamptz | да | |

**Предлагаемые поля**

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| user_type | text | да | `employee` (по умолчанию) / `external` |
| counterparty_id | uuid | для `external` | FK → `counterparties.id` |
| phone | text | нет | рабочий телефон |
| whatsapp_phone | text | нет | номер для уведомлений WhatsApp |
| notification_preferences | jsonb | нет | каналы по типам уведомлений: `in_app`, `email`, `whatsapp` |
| primary_warehouse_id | uuid | нет | FK → `warehouses.id` |
| deactivated_at | timestamptz | нет | когда отключён доступ |
| deactivated_by | uuid | нет | FK → `profiles.id` |

- **PK**: id
- **Ограничения**: `check (user_type = 'employee' or counterparty_id is not null)`
- **Статусы**: активен (`is_active = true`) / отключён
- **Связи**: `user_roles`, `user_permission_overrides`, ссылки `*_user_id` во всех бизнес-таблицах
- **Архивирование**: `is_active = false`; строка не удаляется, пока жива учётная запись
- **audit_log**: create, update (с before/after), deactivate, reactivate
- **Пример**: Рафия — `job_title` «Старший менеджер по логистике», роль доступа `administrator` (см. `user_roles`).

### app_roles — Реализовано

Роли доступа.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | уникальный код |
| name | text | да | название на русском |
| description | text | нет | |
| is_system | boolean | да | системная роль (по умолчанию true) |
| is_enabled | boolean | да | роль действует |
| created_at / updated_at | timestamptz | да | |

- **Уникальные ограничения**: code
- **Роли в базе**: `director`, `executive_director`, `commercial_director`, `logistics_director`, `senior_logistics_manager`, `logistics_specialist`, `accountant`, `marketer`, `administrator`.
- **Предлагаемые роли для внешних пользователей** (пока не созданы): `external_client` (фаза 8), позже `external_broker`, `external_carrier` — **«Требует подтверждения ARSEO»**.
- **Предлагаемое поле**: `audience text` — `internal` / `external`, чтобы роль внешнего пользователя нельзя было назначить сотруднику и наоборот.
- **Статусы**: включена (`is_enabled = true`) / отключена
- **Архивирование**: `is_enabled = false`. Системные роли не удаляются: у `user_roles.role_id` стоит `on delete restrict`.
- **audit_log**: create, update, enable, disable

### permissions — Реализовано

Атомарные права «модуль + действие».

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | `module.action`, уникальный |
| module | text | да | модуль (раздел доступа) |
| action | text | да | действие |
| name | text | да | название на русском |
| description | text | нет | |

- **Уникальные ограничения**: code; (module, action)
- **Базовые права первой миграции (12)**: `users.view`, `users.manage`, `roles.manage`, `shipments.view`, `shipments.create`, `shipments.update`, `shipments.approve`, `documents.view`, `documents.manage`, `finance.view`, `finance.manage`, `audit.view`.
- **Фактический набор после миграций до `202609274000` — 99 кодов**. Полный перечень модулей и действий описан в [`roles-permissions.md`](./roles-permissions.md), раздел «Коды прав». `documents.manage` и `tasks.update` сохранены для совместимости; новые правила используют точные права модулей.
- **Архивирование**: не применяется; справочник меняется только миграциями
- **audit_log**: изменения через миграции фиксируются в истории миграций, а не в `audit_log`

### role_permissions — Расширение

Права ролей.

**Реализованные поля**: `role_id` (FK → `app_roles.id`), `permission_id` (FK → `permissions.id`), `granted boolean` (по умолчанию true). PK — (role_id, permission_id).

**Предлагаемое поле**

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| scope | text[] | нет | ограничения области; все условия должны выполняться. Значения: `own` (свои записи), `assigned` (где сотрудник ответственный или исполнитель), `own_warehouse`, `summary` (только сводные показатели), `import` / `export` (тип поставки), `no_prices` (без цен), `own_counterparty` (для внешних), `shared_only` (только открытые для внешнего доступа). Пусто = без ограничения |

- **Соответствие значениям матрицы прав**: «разрешено» — `granted = true`, `scope` пусто; «ограничено» — `granted = true` + `scope`; «запрещено» — строки нет или `granted = false`; «по отдельному разрешению» — строки для роли нет, разрешение выдаётся сотруднику через `user_permission_overrides`.
- **Текущее состояние**: все 12 прав выданы только роли `administrator`. Права остальных ролей задаются в фазе 0.
- **audit_log**: grant, revoke, scope_changed — всегда с before/after

### user_roles — Реализовано

Назначение ролей пользователям. Поддерживает несколько ролей у одного пользователя.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| user_id | uuid | да | FK → `profiles.id` (on delete cascade) |
| role_id | uuid | да | FK → `app_roles.id` (on delete restrict) |
| assigned_by | uuid | нет | FK → `profiles.id` |
| assigned_at | timestamptz | да | |

- **PK**: (user_id, role_id)
- **Предлагаемое поле**: `expires_at timestamptz` — временная роль (**«Требует подтверждения ARSEO»**, нужна ли).
- **Архивирование**: снятие роли — удаление строки; история сохраняется в `audit_log`.
- **audit_log**: assign, revoke (удаление строки обязательно записывается в `audit_log`, иначе история теряется)

### user_permission_overrides — Новая (фаза 0)

Индивидуальные разрешения и запреты поверх ролей. Реализует «по отдельному разрешению» и точечные ограничения администратора; используется и для внешних пользователей.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| user_id | uuid | да | FK → `profiles.id` |
| permission_id | uuid | да | FK → `permissions.id` |
| effect | text | да | `allow` / `deny` |
| scope | text[] | нет | как в `role_permissions.scope` |
| reason | text | да | основание |
| granted_by | uuid | да | FK → `profiles.id` |
| granted_at | timestamptz | да | |
| expires_at | timestamptz | нет | |
| revoked_at / revoked_by | timestamptz / uuid | нет | отзыв |

- **Уникальные ограничения**: (user_id, permission_id) среди неотозванных
- **Статусы**: действует / истёк / отозван
- **Архивирование**: отзыв через `revoked_at`, строка не удаляется
- **audit_log**: grant, deny, revoke

### audit_log — Реализовано

Единый неизменяемый журнал действий.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | bigint identity | да | PK |
| actor_user_id | uuid | нет | FK → `profiles.id` (on delete set null); пусто — системное действие |
| action | text | да | `create`, `update`, `status_changed`, `approved`, `skipped` и т.д. |
| entity_type | text | да | имя таблицы или сущности |
| entity_id | text | нет | идентификатор записи (text, чтобы хранить и uuid, и bigint) |
| before_data | jsonb | нет | состояние до |
| after_data | jsonb | нет | состояние после |
| metadata | jsonb | да | контекст: причина, IP, источник (`ui`, `integration`, `system`), `on_behalf_of` |
| created_at | timestamptz | да | |

- **Индексы**: (actor_user_id, created_at desc); (entity_type, entity_id, created_at desc)
- **Права в текущей миграции**: UPDATE и DELETE не выданы никому. Добавлять записи может сам пользователь от своего имени. Читают свои записи — все, все записи — `administrator` и `director`.
- **Рекомендация**: критичные события (права, статусы, финансы, остатки) писать триггерами БД или серверным кодом, а не только из браузера — см. [`database-mapping.md`](./database-mapping.md).
- **Архивирование**: не удаляется в течение срока хранения (2–3 года, точный срок уточняется)
- **Что пишется**: указано в описании каждой сущности ниже

---

## 3. Контрагенты и договоры

### counterparties — Новая (фаза 1)

Единый справочник: производители, поставщики, клиенты, перевозчики, брокеры, типографии.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| roles | text[] | да | одна или несколько ролей: `manufacturer`, `supplier`, `customer`, `carrier`, `broker`, `printing_house`, `other` |
| legal_name | text | да | |
| short_name | text | нет | |
| country | text | да | код страны ISO 3166-1 |
| tax_id | text | нет | БИН / ИНН / VAT; формат по стране не проверяется до подтверждения |
| registration_number | text | нет | |
| website | text | нет | |
| default_currency_id | uuid | нет | FK → `currencies.id` |
| preferred_locale | text | нет | `ru` / `en` / `kk` для документов и писем |
| min_remaining_shelf_life_pct | numeric(5,2) | нет | требование клиента к ОСГ по умолчанию (для `customer`); место хранения — **«Требует подтверждения ARSEO»** |
| status | text | да | |
| notes | text | нет | |

- **PK**: id · **FK**: default_currency_id
- **Уникальные ограничения**: (country, tax_id), если tax_id заполнен; иначе предупреждение о возможном дубле по (legal_name, country)
- **Статусы**: `active`, `on_hold`, `archived`
- **Связи**: counterparties_contacts, contracts, shipments (поставщик / клиент), carriers, brokers, product_identifiers (артикул поставщика), sales, profiles (внешние пользователи), integration_mappings (коды 1С)
- **Архивирование**: `archived_at`; нельзя, пока есть незакрытые поставки, продажи или задолженность
- **audit_log**: create, update, status_changed, archive
- Несколько ролей у одного контрагента разрешены (например, поставщик и клиент).

### counterparties_contacts — Новая (фаза 1)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → `counterparties.id` |
| full_name | text | да | |
| position | text | нет | |
| phone | text | нет | |
| whatsapp_phone | text | нет | |
| email | text | нет | |
| is_primary | boolean | да | |
| archived_at | timestamptz | нет | |

- **PK**: id · **FK**: counterparty_id
- **Архивирование**: `archived_at` (персональные данные удаляются по окончании срока хранения)
- **audit_log**: create, update, archive

### contracts — Новая (фаза 1)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → `counterparties.id` |
| number | text | да | |
| type | text | да | `supply`, `sale`, `service`, `agency`, `nda`, `other` |
| currency_id | uuid | нет | FK → `currencies.id` |
| sign_date / valid_from / valid_to | date | нет | |
| incoterms | text | нет | перечень — **«Требует подтверждения ARSEO»** |
| status | text | да | |
| document_id | uuid | нет | FK → `documents.id` (файл договора) |
| notes | text | нет | |

- **Уникальные ограничения**: (counterparty_id, number)
- **Статусы**: `draft`, `active`, `expired`, `terminated`
- **Связи**: contract_terms, shipments, sales
- **Архивирование**: `archived_at` после `expired` или `terminated`
- **audit_log**: create, update, status_changed

### contract_terms — Новая (фаза 1)

Условия договора, в том числе требования клиента к ОСГ, условия возвратов и промо.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| contract_id | uuid | да | FK → `contracts.id` |
| term_type | text | да | `price`, `payment_terms`, `delivery_terms`, `min_remaining_shelf_life_pct`, `return_terms`, `promo_terms`, `penalty`, `other` |
| product_id | uuid | нет | FK → `products.id` — условие по конкретному товару |
| value_numeric | numeric(14,4) | нет | |
| value_text | text | нет | |
| valid_from / valid_to | date | нет | |

- **Правило**: требование к ОСГ ищется так: товар в договоре → договор → `counterparties.min_remaining_shelf_life_pct` (**«Требует подтверждения ARSEO»**)
- **audit_log**: create, update, archive

---

## 4. Товары

### products — Новая (фаза 1)

Карточка товара.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| internal_sku | text | да | внутренний артикул |
| name | jsonb | да | наименование: `ru` — обязательно, `en` и `kk` — по мере заполнения |
| manufacturer_id | uuid | да | FK → `counterparties.id` |
| brand | text | нет | |
| country_of_origin | text | нет | |
| composition | jsonb | нет | состав на языках |
| nutrition_facts | jsonb | нет | КБЖУ на 100 г |
| hs_code | text | нет | код ТН ВЭД |
| temperature_regime | text | нет | `frozen`, `chilled`, `ambient`; диапазон — в `temperature_range` |
| temperature_range | text | нет | например «+2…+6 °C» |
| shelf_life_days | integer | нет | полный срок годности |
| base_uom | text | да | `piece`, `box`, `layer`, `pallet`, `truck` |
| default_currency_id | uuid | нет | FK → `currencies.id` |
| base_purchase_price | numeric(14,4) | нет | видимость — по правам |
| requires_marking | boolean | да | нужна маркировка «Честный знак» (для поставок российским партнёрам) |
| requires_sticker | boolean | да | нужна стикеровка для продажи в Казахстане |
| status | text | да | |

- **Уникальные ограничения**: internal_sku
- **Статусы**: `draft`, `active`, `discontinued`, `archived`
- **Связи**: product_identifiers, product_packaging, batches, shipment_items, sale_items, sticker_templates, forecast_lines, promo_plan_items, product_listing_card_items
- **Изображения, сертификаты, спецификации** — записи `documents` с `entity_type = product`
- **Обязательные поля для пилота** — **«Требует подтверждения ARSEO»** (вопрос М3)
- **Архивирование**: нельзя при ненулевом остатке или активных резервах
- **audit_log**: create, update, price_changed, status_changed, archive

### product_identifiers — Новая (фаза 1)

Артикул поставщика, GTIN, штрихкоды. **Артикул поставщика и GTIN — основные ключи сопоставления с 1С и документами поставщиков.**

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → `products.id` |
| identifier_type | text | да | `supplier_sku`, `gtin`, `unit_barcode`, `box_barcode` |
| value | text | да | |
| counterparty_id | uuid | для `supplier_sku` | FK → `counterparties.id` |
| packaging_uom | text | нет | уровень упаковки для штрихкода |
| is_primary | boolean | да | |

- **Уникальные ограничения**: (identifier_type, value) для `gtin`, `unit_barcode`, `box_barcode`; (counterparty_id, value) для `supplier_sku`
- **Один штрихкод — один товар** (миграция 202609271900): значение `gtin`, `unit_barcode` или `box_barcode` не может принадлежать двум товарам ни в каком из этих типов. Числовые коды сравниваются в форме GTIN-14 (`private.barcode_key`); проверку выполняет триггер `guard_product_barcode`
- **Импорт**: `public.import_reference_data` — см. `docs/reference-import.md`
- **audit_log**: create, update, archive

### product_packaging — Новая (фаза 1)

Упаковка и пересчёт единиц: штука → короб → слой → паллета → фура.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → `products.id` |
| uom | text | да | `piece`, `box`, `layer`, `pallet`, `truck` |
| units_per_parent | numeric(12,3) | да | сколько единиц предыдущего уровня в этой (штук в коробе, коробов в слое, слоёв в паллете, паллет в фуре) |
| gross_weight_kg / net_weight_kg | numeric(10,3) | нет | |
| volume_m3 | numeric(10,4) | нет | |
| length_cm / width_cm / height_cm | numeric(8,2) | нет | |

- **Уникальные ограничения**: (product_id, uom)
- **audit_log**: create, update, archive

---

## 5. Склады, партии и остатки

### warehouses — Новая (фаза 1)

Склады: Актобе (основной хаб: приёмка европейских грузов, стикеровка), Астана, Алматы; служебный склад «В пути».

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | например `AKT`, `AST`, `ALA`, `IN_TRANSIT` |
| name | jsonb | да | |
| city / country | text | для физических | |
| address | text | нет | |
| is_main_hub | boolean | да | Актобе = true |
| is_virtual | boolean | да | служебный склад без адреса |
| head_user_id | uuid | нет | FK → `profiles.id` — заведующий складом, если у него есть учётная запись |
| head_name | text | нет | ФИО заведующего складом, если он не пользователь Nexus |
| status | text | да | `active`, `archived` |

- **Уникальные ограничения**: code
- **audit_log**: create, update, status_changed

### warehouse_locations — Новая (фаза 1)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| warehouse_id | uuid | да | FK → `warehouses.id` |
| code | text | да | |
| zone | text | да | `receiving`, `storage`, `picking`, `quarantine`, `stickering`, `shipping` |
| temperature_regime | text | нет | |
| status | text | да | `active`, `blocked`, `archived` |

- **Уникальные ограничения**: (warehouse_id, code)
- Нужны ли ячейки на каждом складе — вопрос П14; на пилоте достаточно зон.
- **audit_log**: create, update, status_changed

### batches — Новая (фаза 4)

Партии. Основа FEFO, контроля ОСГ и прослеживаемости.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → `products.id` |
| batch_number | text | да | номер партии в Nexus; правило формирования — вопрос М7 |
| supplier_batch_number | text | нет | серия производителя |
| manufacture_date | date | нет | |
| expiry_date | date | да | |
| shipment_id | uuid | нет | FK → `shipments.id` (входящая поставка) |
| shipment_item_id | uuid | нет | FK → `shipment_items.id` |
| quantity_received | numeric(14,3) | да | в `products.base_uom` |
| unit_landed_cost | numeric(14,4) | нет | себестоимость единицы после утверждения (фаза 5) |
| cost_currency_id | uuid | нет | FK → `currencies.id` |
| status | text | да | |
| status_reason | text | нет | причина блокировки или карантина |
| quality_notes | text | нет | |

- **Уникальные ограничения**: (product_id, batch_number)
- **Статусы**: `active`, `quarantined`, `blocked` (ручная блокировка), `expired`, `depleted`
- **ОСГ (формула-допущение, «Требует подтверждения ARSEO», вопрос М8)**: `ОСГ % = (expiry_date − дата расчёта) / (expiry_date − manufacture_date) × 100`. Если `manufacture_date` неизвестна — знаменатель `products.shelf_life_days`. Дата расчёта по умолчанию — плановая дата отгрузки клиенту. ОСГ не хранится, а вычисляется (представление `batch_shelf_life`).
- **Известно**: многие клиенты не принимают товар с ОСГ около 20–30%; если ОСГ ниже условий клиента, нужно гарантийное письмо.
- **Связи**: inventory_balances, inventory_movements, inventory_reservations, sale_items, sticker_order_items, marking_codes, guarantee_letter_items, customer_return_items, promo_plan_items (распродажа)
- **Архивирование**: не архивируется; жизненный цикл — через статус
- **audit_log**: create, status_changed (с причиной), expiry_changed, cost_approved

### inventory_balances — Новая (фаза 4)

Производная таблица остатков по складу, ячейке и партии. Пересчитывается из `inventory_movements`.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| warehouse_id | uuid | да | FK → `warehouses.id` |
| location_id | uuid | нет | FK → `warehouse_locations.id` |
| product_id | uuid | да | FK → `products.id` |
| batch_id | uuid | да | FK → `batches.id` |
| quantity_on_hand | numeric(14,3) | да | |
| quantity_reserved | numeric(14,3) | да | |
| quantity_blocked | numeric(14,3) | да | |
| last_movement_at | timestamptz | нет | |

- **Уникальные ограничения**: (warehouse_id, location_id, batch_id), пустая ячейка считается значением
- **Доступно к отгрузке** = on_hand − reserved − blocked
- **audit_log**: нет (источник — движения)

### inventory_movements — Новая (фаза 4)

Журнал складских движений. Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| movement_type | text | да | `receipt`, `issue`, `transfer`, `write_off`, `return`, `adjustment`, `in_transit_start`, `in_transit_end` |
| warehouse_id | uuid | да | FK → `warehouses.id` |
| location_id | uuid | нет | FK → `warehouse_locations.id` |
| product_id / batch_id | uuid | да | FK |
| quantity | numeric(14,3) | да | со знаком: приход +, расход − |
| shipment_id / shipment_transport_id | uuid | нет | FK |
| sale_item_id | uuid | нет | FK → `sale_items.id` |
| customer_return_item_id | uuid | нет | FK → `customer_return_items.id` |
| transfer_group_id | uuid | нет | связывает две записи перемещения |
| reversal_of_id | uuid | нет | FK → `inventory_movements.id` (сторно) |
| reason | text | для списания и корректировки | |
| recorded_by | uuid | да | FK → `profiles.id` — кто внёс в Nexus |
| performed_by_name | text | нет | кто физически выполнил (работник склада), если он не пользователь |
| occurred_at | timestamptz | да | |

- **Перемещение** — пара записей с общим `transfer_group_id`.
- **Товар в пути** — служебный склад `IN_TRANSIT`: `in_transit_start` переносит количество туда, `in_transit_end` — на склад назначения.
- **Архивирование**: не удаляется; исправление — сторно
- **audit_log**: create (каждое движение), reversal

### inventory_reservations — Новая (фаза 4)

Резервы и ручные блокировки количества.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK |
| batch_id | uuid | нет | FK; подбирается по FEFO |
| warehouse_id | uuid | да | FK |
| quantity | numeric(14,3) | да | |
| reserved_for_type | text | да | `sale_item`, `transfer`, `promo`, `manual_block` |
| reserved_for_id | uuid | нет | полиморфная ссылка |
| is_fefo_override | boolean | да | выбрана не та партия, которую предлагает FEFO |
| override_reason | text | если override | |
| override_approved_by | uuid | нет | FK → `profiles.id` |
| status | text | да | `active`, `fulfilled`, `cancelled`, `expired` |
| expires_at | timestamptz | нет | |
| created_by | uuid | да | FK |

- **audit_log**: create, fefo_override, fulfilled, cancelled

---

## 6. Поставки и процесс

### process_templates — Новая (фаза 2)

Шаблон процесса поставки. Базовый шаблон — 18 этапов RVI (см. [`process-rvi.md`](./process-rvi.md)).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | например `import_eu_kz` |
| version | integer | да | |
| name | jsonb | да | |
| shipment_type | text | нет | `import`, `export`, `domestic_transfer`; пусто = любой |
| route_id | uuid | нет | FK → `routes.id`; пусто = любой маршрут |
| enforcement_mode | text | да | `advisory` — нарушение порядка разрешено с причиной и предупреждением; `strict` — запрещено. На пилоте `advisory` |
| is_default | boolean | да | |
| status | text | да | `draft`, `active`, `archived` |

- **Уникальные ограничения**: (code, version)
- **audit_log**: create, update, activated, archived

### shipment_stages — Новая (фаза 2)

Этапы шаблона процесса и правила их применения.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| process_template_id | uuid | да | FK → `process_templates.id` |
| code | text | да | например `warehouse_receiving` |
| name | jsonb | да | |
| sequence_order | integer | да | рекомендуемый порядок |
| requirement | text | да | `required`, `optional`, `conditional` |
| condition_rules | jsonb | нет | когда этап обязателен или не нужен: по маршруту, стране клиента, признакам товара (`requires_marking`, `requires_sticker`), типу поставки |
| predecessor_codes | text[] | нет | этапы, которые желательно завершить раньше |
| parallel_group | text | нет | этапы одной группы можно вести одновременно |
| scope | text | да | `shipment` или `transport` (для каждой перевозки отдельно) |
| default_responsible_role | text | нет | код роли из `app_roles` |
| sla_days | integer | нет | контрольный срок; значения — после пилота (вопрос П1) |
| status_category | text | да | общий статус поставки для этого этапа (см. `shipments.status`) |
| is_active | boolean | да | |

- **Уникальные ограничения**: (process_template_id, code)
- **audit_log**: create, update

### shipments — Новая (фаза 2)

Поставка.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_number | text | да | |
| project_code | text | нет | код проекта, например Leib7-x |
| type | text | да | `import`, `export`, `domestic_transfer` |
| supplier_id | uuid | для `import` | FK → `counterparties.id` |
| customer_id | uuid | для `export` | FK → `counterparties.id` |
| route_id | uuid | да | FK → `routes.id` |
| contract_id | uuid | нет | FK → `contracts.id` |
| process_template_id | uuid | да | FK → `process_templates.id` |
| status | text | да | общий статус, вычисляется из этапов |
| leading_stage_id | uuid | нет | FK → `shipment_stages.id` — ведущий этап (см. ниже) |
| currency_id | uuid | да | FK → `currencies.id` |
| incoterms | text | нет | |
| destination_warehouse_id | uuid | да | FK → `warehouses.id` |
| responsible_user_id | uuid | да | FK → `profiles.id` |
| planned_ready_date / planned_arrival_date | date | нет | |
| hold_reason / cancel_reason | text | нет | |
| is_locked | boolean | да | true после закрытия |
| closed_at / closed_by | timestamptz / uuid | нет | |

- **Уникальные ограничения**: shipment_number
- **Статусы** (`status`): `planning`, `in_production`, `preparing_transport`, `in_transit`, `customs`, `receiving`, `sales`, `closed`, `on_hold`, `cancelled`. Русские названия и соответствие этапам — в `process-rvi.md`.
- **Ведущий этап** — самый ранний по `sequence_order` этап, который обязателен и ещё не завершён. `status` = `status_category` ведущего этапа. Так статус однозначен и при параллельных этапах. `on_hold` и `cancelled` имеют приоритет.
- **Связи**: shipment_transports, shipment_items, shipment_stage_runs, customs_clearances, expenses, documents, batches, approvals, tasks
- **Архивирование**: закрытая поставка блокируется (`is_locked`). Открыть её повторно могут `director` и `logistics_director` с указанием причины (**«Требует подтверждения ARSEO»**).
- **audit_log**: create, update, status_changed, hold, resume, cancelled, closed, reopened

### shipment_transports — Новая (фаза 2)

Перевозка — один автомобиль или рейс поставки.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK → `shipments.id` |
| sequence_no | integer | да | 1, 2… |
| carrier_id | uuid | нет | FK → `carriers.id` |
| vehicle_id | uuid | нет | FK → `vehicles.id` |
| driver_name / driver_phone | text | нет | персональные данные, доступ ограничен |
| temperature_setpoint | text | нет | |
| planned_loading_date / actual_loading_date | date | нет | |
| planned_arrival_date / actual_arrival_date | date | нет | |
| status | text | да | `planned`, `loading`, `in_transit`, `at_customs`, `arrived`, `unloaded`, `cancelled` |
| notes | text | нет | |

- **Уникальные ограничения**: (shipment_id, sequence_no)
- **audit_log**: create, update, status_changed

### shipment_items — Новая (фаза 2)

Позиции поставки: и заказ поставщику, и фактически принятый товар.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK → `shipments.id` |
| shipment_transport_id | uuid | нет | FK → `shipment_transports.id` — в каком автомобиле |
| product_id | uuid | да | FK → `products.id` |
| uom | text | да | |
| ordered_quantity | numeric(14,3) | да | заказано |
| confirmed_quantity | numeric(14,3) | нет | подтверждено поставщиком |
| shipped_quantity | numeric(14,3) | нет | по упаковочному листу |
| received_quantity | numeric(14,3) | нет | принято по факту |
| unit_price | numeric(14,4) | нет | |
| currency_id | uuid | нет | FK |
| discrepancy_reason | text | если есть расхождение | |
| discrepancy_accepted_by | uuid | нет | FK → `profiles.id` |

- **Уникальные ограничения**: (shipment_id, shipment_transport_id, product_id). Один товар может занимать несколько строк — по одной на автомобиль.
- **Связи**: batches (через `batches.shipment_item_id`), expense_allocations
- **audit_log**: create, update, quantity_changed, discrepancy_accepted

### shipment_stage_runs — Новая (фаза 2)

Состояние каждого этапа по конкретной поставке (или перевозке). Позволяет вести этапы параллельно и пропускать их.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK |
| stage_id | uuid | да | FK → `shipment_stages.id` |
| shipment_transport_id | uuid | для этапов со `scope = transport` | FK |
| is_required | boolean | да | вычисляется по правилам шаблона, может быть изменено с причиной |
| status | text | да | |
| responsible_user_id | uuid | нет | FK → `profiles.id` |
| performed_by_name | text | нет | фактический исполнитель, если он не пользователь (например, работник склада) |
| due_at | timestamptz | нет | из `sla_days` |
| started_at / completed_at | timestamptz | нет | |
| status_reason | text | для `skipped`, `not_applicable`, `blocked`, изменения `is_required` | |

- **Уникальные ограничения**: (shipment_id, stage_id, shipment_transport_id)
- **Статусы**: `pending`, `in_progress`, `blocked`, `completed`, `skipped`, `not_applicable`
- **audit_log**: каждое изменение статуса и `is_required` (с причиной) — дублируется в `shipment_stage_history`

### shipment_stage_history — Новая (фаза 2)

Журнал переходов этапов. Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| stage_run_id | uuid | да | FK → `shipment_stage_runs.id` |
| shipment_id | uuid | да | FK |
| from_status / to_status | text | да | |
| changed_by | uuid | да | FK → `profiles.id` |
| performed_by_name | text | нет | от чьего имени (например, заведующий складом) |
| reason | text | для пропуска и нарушений порядка | |
| warnings | jsonb | нет | предупреждения, которые пользователь подтвердил (этап раньше предшественника, пропуск обязательного этапа) |
| created_at | timestamptz | да | |

- **Архивирование**: не удаляется
- **audit_log**: запись `stage_status_changed` со ссылкой на строку истории

### routes — Новая (фаза 1)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| origin_country / destination_country | text | да | |
| name | jsonb | да | например «Финляндия → Казахстан» |
| via_countries | text[] | нет | транзит |
| typical_transit_days | integer | нет | |
| default_process_template_id | uuid | нет | FK |
| status | text | да | `active`, `archived` |

- **Маршруты**: Финляндия, Нидерланды, Германия, Бельгия, Турция → Казахстан; Турция → Грузия; Грузия → Россия; Казахстан → Россия; Казахстан → Кыргызстан.
- **Уникальные ограничения**: (origin_country, destination_country, name) — допускает несколько вариантов одного направления
- **audit_log**: create, update, status_changed

### carriers — Новая (фаза 1)

Расширение контрагента-перевозчика.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → `counterparties.id`, уникально |
| transport_types | text[] | нет | `truck`, `rail`, `sea`, `air` |
| has_refrigerated_fleet | boolean | нет | |
| notes | text | нет | |

- **audit_log**: create, update

### vehicles — Новая (фаза 1)

Автомобили перевозчиков. Водители указываются в конкретной перевозке (`shipment_transports`), потому что меняются от рейса к рейсу.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| carrier_id | uuid | да | FK → `carriers.id` |
| plate_number | text | да | |
| trailer_plate_number | text | нет | |
| vehicle_type | text | да | `truck`, `trailer`, `refrigerator` |
| temperature_capability | text | нет | |
| status | text | да | `active`, `archived` |

- **Уникальные ограничения**: plate_number
- **audit_log**: create, update

### brokers — Новая (фаза 1)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK, уникально |
| countries_serviced | text[] | нет | |
| notes | text | нет | |

- **audit_log**: create, update

### customs_clearances — Новая (фаза 2)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK |
| shipment_transport_id | uuid | нет | FK — если оформление по автомобилю |
| broker_id | uuid | нет | FK → `brokers.id` |
| country | text | да | |
| declaration_number | text | нет | |
| status | text | да | |
| submitted_at / cleared_at | timestamptz | нет | |
| customs_value | numeric(14,2) | нет | |
| duties_amount / fees_amount | numeric(14,2) | нет | |
| currency_id | uuid | нет | FK |

- **Статусы**: `pending`, `submitted`, `in_progress`, `cleared`, `rejected`, `on_hold`
- **audit_log**: create, update, status_changed

---

## 7. Документы и согласования

### documents — Новая (фаза 3)

Метаданные документа. Файл — в Google Drive или Supabase Storage (см. «Файлы и документы»).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| doc_type | text | да | `invoice`, `cmr`, `ttn`, `snt`, `waybill` (накладная), `packing_list`, `specification`, `contract`, `purchase_order`, `order_confirmation`, `guarantee_letter`, `customs_doc`, `client_input_card`, `client_output_card`, `discrepancy_act`, `certificate`, `product_image`, `sticker_layout`, `marking_codes_file`, `other` |
| doc_number | text | нет | |
| doc_date | date | нет | |
| entity_type | text | нет | `shipment`, `shipment_transport`, `contract`, `product`, `counterparty`, `customs_clearance`, `sale`, `guarantee_letter`, `customer_return`, `product_listing_card`, `sticker_template_version`, `marking_code_order`, `promo_plan` |
| entity_id | uuid | нет | |
| counterparty_id | uuid | нет | FK → `counterparties.id` |
| language | text | нет | `ru`, `en`, `kk` |
| source | text | да | `manual_upload`, `external_upload`, `google_drive_import`, `generated` |
| template_id | uuid | нет | FK → `document_templates.id` |
| visibility | text | да | `internal` (по умолчанию) / `shared_with_counterparty` |
| current_version_id | uuid | нет | FK → `document_versions.id` |
| status | text | да | |
| created_by | uuid | да | FK → `profiles.id` |

- **Статусы**: `draft`, `uploaded`, `under_review`, `approved`, `rejected`, `expired`
- **Внешний пользователь** видит документ, только если `visibility = shared_with_counterparty` и `counterparty_id` — его контрагент. Загруженный им документ получает статус `uploaded` и проверяется сотрудником.
- **Архивирование**: `archived_at` после закрытия связанной поставки; не удаляется в течение срока хранения
- **audit_log**: create, new_version, status_changed, approved, rejected, visibility_changed, downloaded (для внешних пользователей — обязательно)

### document_versions — Новая (фаза 3)

Версии файла. Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| document_id | uuid | да | FK |
| version_number | integer | да | |
| storage_provider | text | да | `google_drive`, `supabase_storage` |
| external_file_id | text | для Drive | ID файла в Google Drive |
| storage_path | text | для Storage | путь в Supabase Storage |
| file_name | text | да | исходное имя |
| mime_type | text | да | |
| source_format | text | да | `pdf`, `xlsx`, `xls`, `csv`, `docx`, `image`, `other` |
| file_size_bytes | bigint | нет | |
| checksum_sha256 | text | нет | контроль дублей и целостности |
| extracted_data | jsonb | нет | данные, распознанные из файла (номер, дата, позиции) |
| validation_result | jsonb | нет | результат проверки против поставки |
| uploaded_by | uuid | да | FK → `profiles.id` |
| uploaded_at | timestamptz | да | |

- **Уникальные ограничения**: (document_id, version_number)
- **audit_log**: uploaded, downloaded

### document_templates — Новая (фаза 3)

> **Реализовано** миграцией `202609271700_document_templates_listing_cards.sql`: вместо `doc_type` — ссылка `document_type_id` на `document_types`, файлы вынесены в `document_template_versions` (версии без удаления), добавлены `purpose`, `is_active`, `current_version`, поля архива. Подробности — `docs/templates-listing-cards.md`.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| doc_type | text | да | |
| name | text | да | |
| language | text | да | `ru`, `en`, `kk` |
| counterparty_id | uuid | нет | шаблон под конкретного клиента (например, его карта ввода) |
| file_ref | jsonb | да | где лежит файл шаблона (Drive или Storage) |
| variables_schema | jsonb | да | поля для подстановки |
| version | integer | да | |
| status | text | да | `draft`, `approved`, `archived` |
| approved_by | uuid | нет | FK |

- **Уникальные ограничения**: (doc_type, name, language, version)
- **audit_log**: create, update, approved, archived

### approvals — Новая (фаза 2)

Согласования любых объектов.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| entity_type | text | да | `shipment_order`, `document`, `discrepancy`, `fefo_override`, `sticker_template_version`, `guarantee_letter`, `expense`, `cost_calculation`, `forecast`, `purchase_plan`, `promo_plan`, `customer_return`, `other` |
| entity_id | uuid | да | |
| approver_user_id | uuid | нет | FK → `profiles.id` |
| approver_role | text | нет | код роли, если согласует любой сотрудник роли |
| requested_by | uuid | да | FK |
| status | text | да | `pending`, `approved`, `rejected`, `cancelled` |
| requested_at / decided_at | timestamptz | | |
| comment | text | для `rejected` | |

- Кто согласует каждый тип — вопрос М6.
- **audit_log**: requested, approved, rejected, cancelled

---

## 8. Задачи и уведомления

### tasks — Новая (фаза 2)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| title | text | да | |
| description | text | нет | |
| entity_type / entity_id | text / uuid | нет | |
| assignee_user_id | uuid | да | FK |
| created_by | uuid | нет | пусто — создана системой |
| priority | text | да | `low`, `normal`, `high`, `urgent` |
| due_at | timestamptz | нет | |
| status | text | да | `open`, `in_progress`, `done`, `cancelled` |
| shipment_id | uuid | нет | FK → `shipments.id`; при указании этапа берётся из него (миграция 202609272200) |
| stage_run_id | uuid | нет | FK → `shipment_stage_runs.id` (миграция 202609272200) |
| started_at / completed_at | timestamptz | нет | взята в работу / завершена или отменена |

- **audit_log**: create, status_changed, reassigned
- **Изменение** — только через функции `create_task`, `set_task_status`, `reassign_task`, `change_task_due`; видимость и правила — `docs/tasks-notifications.md`

### comments — Новая (фаза 2)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| entity_type / entity_id | text / uuid | да | |
| author_user_id | uuid | да | FK |
| body | text | да | |
| visibility | text | да | `internal` / `shared_with_counterparty` |
| edited_at / archived_at | timestamptz | нет | |

- **audit_log**: create, edited, archived

### notifications — Новая (фаза 2)

Уведомление получателю. Каналы: внутри системы, электронная почта, WhatsApp.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| recipient_user_id | uuid | да | FK → `profiles.id` |
| type | text | да | `deadline`, `overdue`, `approval_request`, `approval_decision`, `status_change`, `discrepancy`, `low_shelf_life`, `document_uploaded`, `sync_error`, `system`, `task_assigned`, `task_reassigned`, `stage_blocked` |
| title / body | text | да / нет | на языке получателя (`profiles.locale`) |
| entity_type / entity_id | text / uuid | нет | |
| is_read / read_at | boolean / timestamptz | | |
| created_at | timestamptz | да | |
| shipment_id | uuid | нет | FK → `shipments.id`, для ссылки на поставку и этап (миграция 202609272200) |
| dedupe_key | text | нет | уникален вместе с `recipient_user_id`; повторная генерация того же события ничего не добавляет |

- **audit_log**: не пишется (массовые события); доставки — в `notification_deliveries`

### notification_deliveries — Новая (фаза 2)

Отправка уведомления по каналу.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| notification_id | uuid | да | FK |
| channel | text | да | `in_app`, `email`, `whatsapp` |
| status | text | да | `queued`, `sent`, `delivered`, `failed`, `skipped` |
| provider_message_id | text | нет | |
| attempts | integer | да | |
| error | text | нет | |
| sent_at | timestamptz | нет | |

- Каналы `in_app` и `email` — фаза 2; `whatsapp` — после выбора провайдера (фаза 6).
- **audit_log**: нет; ошибки видны администратору

---

## 9. Финансы

### currencies — Новая (фаза 1)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | ISO 4217: `KZT`, `RUB`, `EUR` |
| name | jsonb | да | |
| is_active | boolean | да | |

- **Уникальные ограничения**: code · **audit_log**: create, update

### exchange_rates — Новая (фаза 5)

Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| base_currency_id / quote_currency_id | uuid | да | FK |
| rate | numeric(18,6) | да | |
| source | text | да | `official`, `bank` |
| source_name | text | нет | название банка или источника |
| rate_date | date | да | |

- **Уникальные ограничения**: (base_currency_id, quote_currency_id, source, rate_date)
- **audit_log**: create

### expenses — Новая (фаза 5)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | нет | FK |
| attributed_customer_id | uuid | нет | FK → `counterparties.id` — расход относится к клиенту (промо, доставка клиенту, возврат) |
| promo_plan_id | uuid | нет | FK → `promo_plans.id` |
| expense_type | text | да | `goods_cost`, `transport`, `logistics`, `broker_fee`, `customs_duty`, `tax`, `stickering`, `marking`, `bank_fee`, `promo`, `return`, `other` |
| payee_counterparty_id | uuid | нет | FK |
| amount | numeric(14,2) | да | |
| currency_id | uuid | да | FK |
| exchange_rate_id | uuid | нет | FK |
| document_id | uuid | нет | FK |
| incurred_at | date | да | |
| is_planned | boolean | да | плановый (до счёта) или фактический |
| status | text | да | `draft`, `confirmed`, `allocated`, `paid` |

- **audit_log**: create, update, status_changed

### expense_allocations — Новая (фаза 5)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| expense_id | uuid | да | FK |
| shipment_item_id | uuid | нет | FK |
| batch_id | uuid | нет | FK |
| allocation_method | text | да | `by_quantity`, `by_weight`, `by_volume`, `by_value`, `manual` |
| allocated_amount | numeric(14,2) | да | |
| currency_id | uuid | да | FK |

- **audit_log**: create, recalculated

### sales — Новая (фаза 4)

Клиентский заказ / продажа.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| sale_number | text | да | |
| customer_id | uuid | да | FK → `counterparties.id` |
| contract_id | uuid | нет | FK |
| warehouse_id | uuid | да | склад отгрузки |
| sale_date / planned_shipment_date | date | да | |
| currency_id | uuid | да | FK |
| status | text | да | `draft`, `confirmed`, `reserved`, `shipped`, `invoiced`, `paid`, `cancelled` |
| total_amount | numeric(14,2) | нет | |
| source | text | да | `nexus`, `onec` |

- **Главный источник**: на пилоте продажи вводятся в Nexus для резервирования по FEFO и контроля ОСГ. Как они будут сверяться с реализациями в 1С «Управление торговлей» — вопрос И2.
- **audit_log**: create, update, status_changed

### sale_items — Новая (фаза 4)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| sale_id | uuid | да | FK |
| product_id | uuid | да | FK |
| batch_id | uuid | нет | FK — после подбора по FEFO |
| quantity / uom | numeric / text | да | |
| unit_price / discount_pct | numeric | нет | |
| promo_plan_item_id | uuid | нет | FK |
| remaining_shelf_life_pct | numeric(5,2) | нет | ОСГ на дату отгрузки (снимок) |
| required_shelf_life_pct | numeric(5,2) | нет | требование клиента (снимок) |
| guarantee_letter_id | uuid | нет | FK → `guarantee_letters.id` — если ОСГ ниже требования |
| cost_amount | numeric(14,2) | нет | себестоимость строки (фаза 5) |

- **Правило**: если `remaining_shelf_life_pct < required_shelf_life_pct`, отгрузку нельзя подтвердить без гарантийного письма (известное правило ARSEO).
- **audit_log**: create, update, batch_assigned

### receivables — Новая (фаза 5)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| customer_id | uuid | да | FK |
| sale_id | uuid | нет | FK |
| external_document_ref | text | нет | документ реализации в 1С |
| currency_id | uuid | да | FK |
| amount_due / amount_paid | numeric(14,2) | да | |
| due_date | date | да | |
| status | text | да | `open`, `partially_paid`, `paid`, `overdue`, `written_off` |
| source | text | да | `onec`, `nexus` |

- **Главный источник** — предположительно 1С (данные только читаются), **«Требует подтверждения ARSEO»** (вопрос И10). В Nexus добавляются комментарии, задачи на взыскание и отчёты по срокам.
- **audit_log**: create, status_changed, written_off (для записей из 1С — фиксируется синхронизацией)

### receivable_payments — Новая (фаза 5)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| receivable_id | uuid | да | FK |
| amount | numeric(14,2) | да | |
| currency_id | uuid | да | FK |
| paid_at | date | да | |
| source | text | да | `onec`, `nexus` |

- **audit_log**: create

### client_profitability_snapshots — Новая (фаза 5)

Зафиксированный расчёт прибыльности клиента за период. Нужен, чтобы утверждённые цифры не менялись при пересчёте.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| customer_id | uuid | да | FK |
| period_start / period_end | date | да | |
| currency_id | uuid | да | FK |
| revenue | numeric(14,2) | да | выручка по `sale_items` |
| cogs | numeric(14,2) | да | себестоимость проданных партий |
| promo_costs | numeric(14,2) | да | расходы с `promo_plan_id` клиента |
| returns_amount | numeric(14,2) | да | |
| logistics_costs | numeric(14,2) | да | расходы с `attributed_customer_id` |
| gross_margin | numeric(14,2) | да | |
| overdue_receivables | numeric(14,2) | нет | на конец периода |
| calculation_params | jsonb | да | курс, методы, версия расчёта |
| status | text | да | `draft`, `approved`, `superseded` |
| approved_by | uuid | нет | FK |

- **Уникальные ограничения**: (customer_id, period_start, period_end) среди `approved`
- **audit_log**: calculated, approved, superseded

---

## 10. Планирование: прогноз, закупки, промо

Прогнозы, планы закупок и промо хранятся версиями. Утверждённая версия не редактируется: изменения — новая версия со ссылкой на предыдущую.

### forecasts — Новая (фаза 7)

Версия прогноза продаж.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| name | text | да | |
| scenario | text | да | `base`, `optimistic`, `pessimistic`, `custom` |
| version | integer | да | |
| based_on_id | uuid | нет | FK → `forecasts.id` — предыдущая версия |
| horizon_start / horizon_end | date | да | |
| granularity | text | да | `week`, `month` |
| method | text | да | `manual`, `moving_average`, `seasonal`, `imported` |
| method_params | jsonb | нет | |
| input_snapshot_at | timestamptz | нет | на какую дату взяты продажи и остатки |
| status | text | да | `draft`, `in_review`, `approved`, `superseded`, `archived` |
| approved_by / approved_at | uuid / timestamptz | нет | |
| created_by | uuid | да | FK |

- **Уникальные ограничения**: (name, scenario, version); одна версия `approved` на сценарий и горизонт
- **audit_log**: create, submitted, approved, superseded

### forecast_lines — Новая (фаза 7)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| forecast_id | uuid | да | FK |
| product_id | uuid | да | FK |
| customer_id | uuid | нет | FK |
| warehouse_id | uuid | нет | FK |
| period_start | date | да | |
| base_quantity | numeric(14,3) | да | прогноз без промо |
| promo_uplift_quantity | numeric(14,3) | да | прирост от промо |
| promo_plan_item_id | uuid | нет | FK |
| final_quantity | numeric(14,3) | да | |
| is_manual_override | boolean | да | |
| comment | text | нет | |

- **Уникальные ограничения**: (forecast_id, product_id, customer_id, warehouse_id, period_start)

### purchase_plans — Новая (фаза 7)

План закупок на основе утверждённого прогноза.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| forecast_id | uuid | да | FK — утверждённый прогноз |
| supplier_id | uuid | нет | FK |
| version | integer | да | |
| based_on_id | uuid | нет | FK → `purchase_plans.id` |
| horizon_start / horizon_end | date | да | |
| status | text | да | `draft`, `in_review`, `approved`, `ordered`, `superseded` |
| approved_by / approved_at | uuid / timestamptz | нет | |

- **audit_log**: create, approved, superseded

### purchase_plan_lines — Новая (фаза 7)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| purchase_plan_id | uuid | да | FK |
| product_id | uuid | да | FK |
| forecast_demand | numeric(14,3) | да | |
| stock_on_hand / stock_in_transit / stock_reserved | numeric(14,3) | да | снимок на дату расчёта |
| safety_stock | numeric(14,3) | нет | правило — **«Требует подтверждения ARSEO»** |
| expiring_before_sale | numeric(14,3) | нет | остаток, который не успеет продаться до критического ОСГ |
| suggested_quantity | numeric(14,3) | да | |
| rounded_quantity | numeric(14,3) | да | с учётом кратности короба, паллеты, фуры |
| approved_quantity | numeric(14,3) | нет | |
| planned_order_date | date | нет | |
| shipment_id | uuid | нет | FK — созданная поставка |

### promo_plans — Новая (фаза 7)

Промо у клиента и распродажа товаров с низким ОСГ.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| promo_type | text | да | `trade_promo` (промо у клиента), `low_shelf_life_clearance` (распродажа с низким ОСГ) |
| name | text | да | |
| customer_id | uuid | нет | FK |
| period_start / period_end | date | да | |
| mechanics | text | нет | механика промо; перечень — вопрос П5 |
| budget_amount | numeric(14,2) | нет | |
| currency_id | uuid | нет | FK |
| version | integer | да | |
| based_on_id | uuid | нет | FK |
| status | text | да | `draft`, `in_review`, `approved`, `active`, `completed`, `cancelled` |
| approved_by / approved_at | uuid / timestamptz | нет | |

- **audit_log**: create, approved, status_changed

### promo_plan_items — Новая (фаза 7)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| promo_plan_id | uuid | да | FK |
| product_id | uuid | да | FK |
| batch_id | uuid | нет | FK — для распродажи конкретной партии |
| promo_price / discount_pct | numeric | нет | |
| planned_quantity | numeric(14,3) | да | |
| actual_quantity | numeric(14,3) | нет | по `sale_items` |

- **Источник кандидатов для распродажи**: партии с ОСГ ниже порога — порог **«Требует подтверждения ARSEO»**.

---

## 11. Работа с клиентами: гарантийные письма, возвраты, карты ввода и вывода

### guarantee_letters — Новая (фаза 4)

Гарантийное письмо клиенту. Нужно, если ОСГ товара ниже условий клиента.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| letter_number | text | да | |
| customer_id | uuid | да | FK |
| sale_id | uuid | нет | FK |
| reason | text | да | `low_shelf_life`, `other` |
| document_id | uuid | нет | FK — сформированное письмо |
| status | text | да | `draft`, `pending_approval`, `approved`, `sent`, `accepted`, `rejected`, `cancelled` |
| sent_at / customer_decision_at | timestamptz | нет | |

- **Содержание и обязательства** берутся из утверждённого шаблона ARSEO; текст здесь не определяется.
- **audit_log**: create, approved, sent, customer_decision

### guarantee_letter_items — Новая (фаза 4)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| guarantee_letter_id | uuid | да | FK |
| product_id / batch_id | uuid | да | FK |
| quantity | numeric(14,3) | да | |
| remaining_shelf_life_pct | numeric(5,2) | да | |
| required_shelf_life_pct | numeric(5,2) | да | |

### customer_returns — Новая (фаза 5)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| return_number | text | да | |
| customer_id | uuid | да | FK |
| sale_id | uuid | нет | FK |
| guarantee_letter_id | uuid | нет | FK — возврат по гарантийному письму |
| reason | text | да | `expired`, `damaged`, `quality`, `guarantee_obligation`, `wrong_item`, `other`; перечень — вопрос П6 |
| warehouse_id | uuid | да | склад приёмки возврата |
| status | text | да | `requested`, `approved`, `rejected`, `in_transit`, `received`, `inspected`, `closed` |
| credit_amount | numeric(14,2) | нет | уменьшение задолженности |
| currency_id | uuid | нет | FK |

- **audit_log**: create, approved, rejected, received, closed

### customer_return_items — Новая (фаза 5)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| customer_return_id | uuid | да | FK |
| product_id / batch_id | uuid | да / нет | FK |
| quantity | numeric(14,3) | да | |
| condition | text | нет | |
| decision | text | нет | `restock`, `write_off`, `return_to_supplier`; правила — вопрос П6 |

- Приёмка возврата — движение `return`; списание — `write_off`.

### product_listing_cards — Новая (фаза 3)

> **Реализовано** миграциями `202609271700_document_templates_listing_cards.sql` и `202609271800_counterparty_template_directions.sql`. Добавлены номер карты, версии (`version`, `previous_version_id`, `root_card_id`), статус `superseded`, поля отправки, решения и отмены; в позициях — `required_quantity`, `uom`, `currency_id`. Редактируется только черновик — это проверяет база. Подробности — `docs/templates-listing-cards.md`.

Карты ввода товаров от поставщиков и вывода товаров для покупателей.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| card_type | text | да | `input` (ввод), `output` (вывод) |
| counterparty_id | uuid | да | FK → `counterparties.id`; поставщик для `input`, покупатель для `output` |
| template_id | uuid | нет | FK → `document_templates.id`; направление и контрагент должны совпадать |
| document_id | uuid | нет | FK — заполненная карта |
| effective_date | date | нет | |
| status | text | да | `draft`, `submitted`, `approved_by_customer`, `rejected_by_customer`, `cancelled` |

- **audit_log**: create, submitted, customer_decision

### product_listing_card_items — Новая (фаза 3)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| card_id | uuid | да | FK |
| product_id | uuid | да | FK |
| counterparty_sku | text | нет | артикул у поставщика для `input`, у покупателя для `output` |
| price | numeric(14,4) | нет | |
| comment | text | нет | |

- Карта заполняется автоматически из карточки товара (GTIN, штрихкоды, упаковка, состав, КБЖУ, срок годности).

---

## 12. Стикеры и маркировка

Стикеры изготавливает типография после согласования макета; наклеивают сотрудники склада ARSEO (в основном в Актобе).

### sticker_templates — Новая (фаза 4)

Стикер для товара (или группы товаров, или клиента).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| name | text | да | |
| product_id | uuid | нет | FK |
| customer_id | uuid | нет | FK — если стикер специфичен для клиента |
| sticker_level | text | да | `unit`, `box`; правило — вопрос М9 |
| languages | text[] | да | языки на стикере |
| current_version_id | uuid | нет | FK → `sticker_template_versions.id` — последняя согласованная |
| status | text | да | `active`, `archived` |

- **audit_log**: create, update, archived

### sticker_template_versions — Новая (фаза 4)

Версии макета стикера; хранятся все, включая отклонённые.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| sticker_template_id | uuid | да | FK |
| version_number | integer | да | |
| content | jsonb | да | текст полей стикера по языкам |
| layout_document_id | uuid | да | FK → `documents.id` — файл макета |
| status | text | да | `draft`, `in_review`, `approved`, `rejected`, `superseded` |
| approved_by / approved_at | uuid / timestamptz | нет | |

- **Правило**: заказать печать можно только по версии `approved`.
- **audit_log**: create, submitted, approved, rejected

### sticker_orders — Новая (фаза 4)

Заказ стикеров в типографии.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| order_number | text | да | |
| printing_house_id | uuid | нет | FK → `counterparties.id` (роль `printing_house`) |
| shipment_id | uuid | нет | FK |
| status | text | да | `draft`, `calculated`, `ordered`, `received`, `applied`, `cancelled` |
| ordered_at / received_at | timestamptz | нет | |
| document_id | uuid | нет | FK — заявка или счёт типографии |

- **audit_log**: create, status_changed

### sticker_order_items — Новая (фаза 4)

Расчёт количества стикеров.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| sticker_order_id | uuid | да | FK |
| sticker_template_version_id | uuid | да | FK — согласованная версия |
| product_id | uuid | да | FK |
| batch_id | uuid | нет | FK — после регистрации партии |
| units_to_label | numeric(14,3) | да | сколько единиц (или коробов) нужно обклеить |
| reserve_pct | numeric(5,2) | да | запас на брак; значение — вопрос М9 |
| calculated_quantity | integer | да | `ceil(units_to_label × (1 + reserve_pct / 100))` |
| ordered_quantity | integer | нет | с учётом минимального тиража типографии |
| received_quantity / applied_quantity / spoiled_quantity | integer | нет | |
| applied_by_name | text | нет | работник склада, наклеивший стикеры |

- **Расчёт**: предварительно — от `confirmed_quantity` поставки (можно заказать заранее, пока товар в пути); окончательно — от `received_quantity`.

### marking_code_orders — Новая (фаза 4)

Заказ кодов маркировки (QR/DataMatrix). Маркировка «Честный знак» относится к работе с российскими партнёрами.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| partner_id | uuid | нет | FK — российский партнёр |
| product_id | uuid | да | FK |
| quantity_requested | integer | да | |
| code_type | text | да | `unit`, `box` |
| status | text | да | `draft`, `requested`, `received`, `partially_applied`, `applied`, `cancelled` |
| codes_document_id | uuid | нет | FK — файл кодов |
| requested_at / received_at | timestamptz | нет | |

- Кто заказывает коды (ARSEO или партнёр) и в каком формате — вопрос И8.
- **audit_log**: create, status_changed

### marking_codes — Новая (фаза 4)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| marking_code_order_id | uuid | нет | FK |
| product_id / batch_id | uuid | да | FK |
| shipment_id | uuid | нет | FK |
| code_type | text | да | `unit`, `box` |
| code_value | text | да | не хранится в GitHub и не выводится в логи |
| status | text | да | предварительно `issued`, `applied`, `shipped`, `withdrawn`; полный перечень — вопрос И8 |
| applied_at | timestamptz | нет | |

- **Уникальные ограничения**: code_value
- **Архивирование**: не удаляется в течение срока хранения
- **audit_log**: imported (пакетом), applied, status_changed

---

## 13. Интеграции

1С («Бухгалтерия 8.3» и «Управление торговлей», сопровождение — «Первый Бит») — только источник: Nexus читает данные и не записывает изменения обратно. Google Drive — действующий источник документов. Google Sheets — рабочие таблицы (основной файл «Калькулятор»).

### integrations — Новая (фаза 6)

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | `google_drive`, `google_sheets`, `onec_accounting` (Бухгалтерия 8.3), `onec_trade` (Управление торговлей), `whatsapp`, `email` |
| name | text | да | |
| direction | text | да | `inbound`, `outbound`, `bidirectional`; для 1С — только `inbound` |
| config | jsonb | нет | без секретов; ключи — в переменных окружения |
| is_active | boolean | да | |

- **Уникальные ограничения**: code
- **audit_log**: create, update, activated, deactivated

### synchronization_runs — Новая (фаза 6)

Журнал синхронизаций. Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| integration_id | uuid | да | FK |
| entity_type | text | да | что синхронизировалось |
| started_at / finished_at | timestamptz | да / нет | |
| status | text | да | `running`, `success`, `failed`, `partial` |
| records_read / records_created / records_updated / records_failed | integer | да | |
| triggered_by | text | да | `schedule`, `manual` |
| triggered_by_user_id | uuid | нет | FK |

- **audit_log**: ручной запуск

### synchronization_errors — Новая (фаза 6)

Ошибки по отдельным записям.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| run_id | uuid | да | FK → `synchronization_runs.id` |
| entity_type | text | да | |
| external_id | text | нет | |
| error_code | text | да | например `no_match`, `ambiguous_match`, `validation_failed` |
| message | text | да | |
| payload | jsonb | нет | без персональных данных сверх необходимого |
| status | text | да | `open`, `resolved`, `ignored` |
| resolved_by / resolved_at | uuid / timestamptz | нет | |

- **audit_log**: resolved, ignored

### integration_mappings — Новая (фаза 6)

Связь записей Nexus с внешними системами.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| integration_id | uuid | да | FK |
| entity_type | text | да | `product`, `counterparty`, `warehouse`, `sale`, `receivable`, `document` |
| internal_id | uuid | да | |
| external_id | text | да | GUID 1С, ID файла Drive, ключ строки Sheets |
| external_code | text | нет | код или артикул во внешней системе |
| match_method | text | да | `supplier_sku`, `gtin`, `tax_id`, `manual`, `guid` |
| last_synced_at | timestamptz | нет | |
| source_hash | text | нет | для определения изменений |

- **Уникальные ограничения**: (integration_id, entity_type, external_id)
- **Сопоставление товаров с 1С** — по артикулу поставщика и GTIN; при неоднозначности — ручное (ошибка `ambiguous_match`)
- **audit_log**: manual_match, unmatch

---

## Сводная схема связей

```
auth.users ── profiles ──< user_roles >── app_roles ──< role_permissions >── permissions
profiles ──< user_permission_overrides >── permissions
profiles >── counterparties (для external)
profiles ──< audit_log / tasks / comments / notifications

counterparties ──< counterparties_contacts
counterparties ──< contracts ──< contract_terms
counterparties ── carriers ──< vehicles
counterparties ── brokers

products ──< product_identifiers / product_packaging
products ──< batches ──< inventory_balances / inventory_movements / inventory_reservations
warehouses ──< warehouse_locations

process_templates ──< shipment_stages
shipments ──< shipment_transports ──< shipment_items
shipments ──< shipment_stage_runs >── shipment_stages
shipment_stage_runs ──< shipment_stage_history
shipments ──< customs_clearances
shipments ──< expenses ──< expense_allocations
shipment_items ──< batches

sales ──< sale_items >── batches
sale_items >── guarantee_letters ──< guarantee_letter_items
sales ──< receivables ──< receivable_payments
customer_returns ──< customer_return_items

forecasts ──< forecast_lines
purchase_plans ──< purchase_plan_lines >── shipments
promo_plans ──< promo_plan_items

sticker_templates ──< sticker_template_versions
sticker_orders ──< sticker_order_items
marking_code_orders ──< marking_codes

documents ──< document_versions
integrations ──< synchronization_runs ──< synchronization_errors
integrations ──< integration_mappings

(*) audit_log, comments, notifications, approvals, documents ссылаются на сущности полиморфно.
```
