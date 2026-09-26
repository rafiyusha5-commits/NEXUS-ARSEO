# Логическая модель данных Nexus-ARSEO

Статус документа: черновик для последующей реализации в PostgreSQL. Документ описывает **логическую** модель (сущности, поля, связи, статусы, правила архивирования и аудита), без готовых SQL-миграций.

Все неопределённые правила, требующие подтверждения ARSEO, отмечены пометкой **«Требует подтверждения ARSEO»**. Полный список открытых вопросов — в [`docs/open-questions.md`](./open-questions.md).

## Общие принципы

- **Первичные ключи** — `id: uuid`, генерируется приложением или БД (`gen_random_uuid()`), если не указано иное.
- **Служебные поля** — у каждой таблицы есть `created_at: timestamptz` и `updated_at: timestamptz`; у справочных и связующих таблиц может быть только `created_at`.
- **Архивирование** — по умолчанию используется «мягкое» архивирование: поле `is_archived: boolean` (по умолчанию `false`) + `archived_at: timestamptz` + `archived_by: uuid → employees.id`. Физическое удаление строк не предусмотрено для сущностей, участвующих в истории (движения, документы, финансы, аудит). Точные правила архивирования указаны для каждой сущности отдельно.
- **Журналы (append-only)** — `inventory_movements`, `shipment_stage_history`, `exchange_rates`, `synchronization_runs`, `audit_log` — записи не редактируются и не удаляются; исправления оформляются новой (сторнирующей) записью.
- **Хранение файлов** — бинарные файлы хранятся в объектном хранилище (S3-совместимом); в PostgreSQL хранятся только метаданные и ссылка (`storage_key` / `storage_url`). Sanity как транзакционная база не используется.
- **Мультивалютность** — везде, где есть денежная сумма, рядом хранится `currency_id → currencies.id`; курсы — в `exchange_rates`.
- **Полиморфные связи** (например, `entity_type` + `entity_id` в `comments`, `notifications`, `approvals`, `audit_log`) реализуются без физического FK-ограничения на уровне БД (проверка целостности — на уровне приложения). Это единственное осознанное отступление от строгих внешних ключей ради простоты модели.
- **Права доступа** — точечные ограничения/расширения прав для отдельного сотрудника (сверх роли) реализуются без отдельной сущности: полем `permissions_override: jsonb` в `employee_roles` (см. также [`docs/roles-permissions.md`](./roles-permissions.md)). Это решение принято, чтобы не выходить за рамки согласованного списка из 47 сущностей.
- **Идентификаторы товара** — внутренний артикул хранится в `products.internal_sku`; артикул поставщика, GTIN, штрихкод единицы и штрихкод короба — в `product_identifiers` (несколько значений на товар).
- **Единицы учёта** — шт / короб / слой паллеты / паллета / фура моделируются в `product_packaging` как коэффициенты пересчёта на товар.
- **Отчёты и прогнозы** не имеют собственных таблиц в этой версии модели: они рассчитываются из `sales`, `inventory_movements`, `inventory_balances`, `expenses` и `receivables`. Таблицы для сохранённых отчётов и утверждённых прогнозов добавляются, когда ARSEO определит их формат (см. `open-questions.md`, 7.3–7.4).

---

## 1. Управление доступом

### users

Назначение: учётная запись для входа в систему (аутентификация). Может отсутствовать у сотрудника, если ему не нужен доступ.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| employee_id | uuid | нет | FK → employees.id, владелец учётной записи |
| email | text | да | логин |
| phone | text | нет | доп. контакт |
| password_hash | text | да* | хэш пароля (*не требуется, если вход только через SSO — «Требует подтверждения ARSEO») |
| is_service_account | boolean | да | признак технической учётной записи (для интеграций) |
| is_active | boolean | да | статус доступа |
| last_login_at | timestamptz | нет | последний вход |

- **PK**: id
- **FK**: employee_id → employees.id
- **Уникальные ограничения**: email
- **Статусы**: active, disabled, locked
- **Связи**: 1–1 с employees; через employees — к employee_roles
- **Архивирование**: не удаляется; при увольнении — is_active = false, employee.status = dismissed
- **audit_log**: create, login_success, login_failed, password_changed, status_changed

### employees

Назначение: карточка сотрудника ARSEO (без привязки к наличию логина).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| full_name | text | да | ФИО |
| position_title | text | нет | должность (свободный текст, может не совпадать с ролью) |
| phone | text | нет | |
| email | text | нет | |
| primary_warehouse_id | uuid | нет | FK → warehouses.id, основной склад |
| hire_date | date | нет | |
| status | enum | да | active / on_leave / dismissed |
| notes | text | нет | |

- **PK**: id
- **FK**: primary_warehouse_id → warehouses.id
- **Уникальные ограничения**: email (если указан)
- **Статусы**: active, on_leave, dismissed
- **Связи**: users (1–1), employee_roles (1–N), tasks.assignee, shipments.responsible_employee_id и др.
- **Архивирование**: status = dismissed + is_archived = true; исторические ссылки (задачи, поставки, документы) не переносятся и не удаляются
- **audit_log**: create, update, status_changed

### roles

Назначение: справочник ролей. Базовые 9 ролей — системные (`is_system = true`), администратор может добавлять собственные роли.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | машинное имя (например `logistics_manager`) |
| name_ru | text | да | «Менеджер по логистике» и т.п. |
| description | text | нет | |
| is_system | boolean | да | нельзя удалить/переименовать базовые роли |
| is_archived | boolean | да | |

- **PK**: id
- **Уникальные ограничения**: code
- **Статусы**: active, archived
- **Связи**: role_permissions (1–N), employee_roles (1–N)
- **Архивирование**: нельзя архивировать роль, если есть активные employee_roles; is_system-роли не архивируются
- **audit_log**: create, update, archive

### permissions

Назначение: атомарные права доступа — комбинация «раздел + действие» (см. разделы и действия в `roles-permissions.md`).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| resource | enum | да | раздел доступа (users, roles, customers, suppliers, products, warehouses, inventory, shipments, import, export, documents, templates, finance, cost, receivables, reports, forecasts, integrations, audit_log, system_settings) |
| action | enum | да | view, create, edit, delete_archive, approve, export, upload, change_status, manage_access |
| code | text | да | сгенерировано как `resource.action` |
| description | text | нет | |

- **PK**: id
- **Уникальные ограничения**: (resource, action)
- **Связи**: role_permissions (1–N)
- **Архивирование**: справочник не архивируется (меняется только через релиз кода)
- **audit_log**: create, update (изменение состава прав — редкое системное событие)

### role_permissions

Назначение: матрица «роль × право» с уровнем доступа.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| role_id | uuid | да | FK → roles.id |
| permission_id | uuid | да | FK → permissions.id |
| access_level | enum | да | allowed / denied / restricted / by_grant |
| updated_by | uuid | нет | FK → employees.id |

- **PK**: id
- **FK**: role_id, permission_id, updated_by
- **Уникальные ограничения**: (role_id, permission_id)
- **Архивирование**: не применимо (обновляется в месте)
- **audit_log**: create, update — критично для безопасности, логируется всегда, включая `before_state`/`after_state`

### employee_roles

Назначение: назначение ролей сотрудникам (M2M) + точечные исключения для конкретного сотрудника.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| employee_id | uuid | да | FK → employees.id |
| role_id | uuid | да | FK → roles.id |
| assigned_by | uuid | да | FK → employees.id |
| assigned_at | timestamptz | да | |
| expires_at | timestamptz | нет | временная роль |
| is_active | boolean | да | |
| permissions_override | jsonb | нет | точечные allow/deny поверх роли, см. «Общие принципы» |

- **PK**: id
- **FK**: employee_id, role_id, assigned_by
- **Уникальные ограничения**: (employee_id, role_id) где is_active = true
- **Архивирование**: is_active = false вместо удаления (нужна история назначений)
- **audit_log**: assign, revoke, override_changed

**Пример**: администратор пилота Рафия (роль «Старший менеджер по логистике») получает дополнительную запись `employee_roles` с ролью «Администратор системы», что даёт ей административные права без создания отдельной сущности.

---

## 2. Контрагенты и договоры

### counterparties

Назначение: единый справочник контрагентов (производители, поставщики, клиенты, перевозчики, брокеры). Тип определяет базовую роль контрагента; расширенные атрибуты — в `carriers` / `brokers`.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| type | enum | да | manufacturer / supplier / customer / carrier / broker / other |
| legal_name | text | да | |
| country | text | да | |
| tax_id | text | нет | ИНН/БИН/VAT — формат по стране **«Требует подтверждения ARSEO»** |
| registration_number | text | нет | |
| website | text | нет | |
| default_currency_id | uuid | нет | FK → currencies.id |
| status | enum | да | |
| notes | text | нет | |

- **PK**: id
- **FK**: default_currency_id → currencies.id
- **Уникальные ограничения**: рекомендуется (legal_name, country); дедупликация по tax_id — **«Требует подтверждения ARSEO»**
- **Статусы**: active, on_hold, archived
- **Связи**: counterparties_contacts, contracts, shipments, carriers, brokers, product_identifiers.counterparty_id
- **Архивирование**: нельзя архивировать при открытых contracts/shipments со статусом, отличным от закрытого/отменённого
- **audit_log**: create, update, status_changed, archive

### counterparties_contacts

Назначение: контактные лица контрагента.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → counterparties.id |
| full_name | text | да | |
| position | text | нет | |
| phone | text | нет | |
| email | text | нет | |
| is_primary | boolean | да | |

- **PK**: id · **FK**: counterparty_id
- **Архивирование**: физическое удаление допустимо (не участвует в истории операций)
- **audit_log**: create, update, delete

### contracts

Назначение: договоры с контрагентами.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → counterparties.id |
| number | text | да | |
| type | enum | да | supply / service / agency / nda / other |
| currency_id | uuid | нет | FK → currencies.id |
| sign_date | date | нет | |
| valid_from | date | нет | |
| valid_to | date | нет | |
| incoterms | text | нет | **«Требует подтверждения ARSEO»** — перечень Incoterms, используемый ARSEO |
| status | enum | да | |
| document_id | uuid | нет | FK → documents.id (скан договора) |
| notes | text | нет | |

- **PK**: id · **FK**: counterparty_id, currency_id, document_id
- **Уникальные ограничения**: (counterparty_id, number)
- **Статусы**: draft, active, expired, terminated
- **Связи**: contract_terms (1–N), shipments.contract_id
- **Архивирование**: не удаляется; переход в terminated/expired + is_archived после подтверждения
- **audit_log**: create, update, status_changed

### contract_terms

Назначение: конкретные условия договора (цены, сроки оплаты, штрафы и т.п.), в т.ч. по отдельным товарам.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| contract_id | uuid | да | FK → contracts.id |
| term_type | enum | да | price / payment_terms / delivery_terms / penalty / other |
| product_id | uuid | нет | FK → products.id |
| description | text | нет | |
| value_numeric | numeric(14,4) | нет | |
| value_text | text | нет | |
| valid_from | date | нет | |
| valid_to | date | нет | |

- **PK**: id · **FK**: contract_id, product_id
- **audit_log**: create, update, delete

---

## 3. Товары

### products

Назначение: карточка товара.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| internal_sku | text | да | внутренний артикул |
| name | text | да | наименование |
| manufacturer_id | uuid | да | FK → counterparties.id |
| country_of_origin | text | нет | |
| composition | text | нет | состав |
| nutrition_facts | jsonb | нет | КБЖУ |
| hs_code | text | нет | код ТН ВЭД — **«Требует подтверждения ARSEO»** обязательность |
| temperature_regime | enum | нет | frozen / chilled / ambient |
| shelf_life_days | integer | нет | срок годности (в днях от даты производства) |
| base_uom | enum | да | piece / box / layer / pallet / truck |
| default_currency_id | uuid | нет | FK → currencies.id |
| base_price | numeric(14,4) | нет | |
| status | enum | да | |
| notes | text | нет | |

- **PK**: id · **FK**: manufacturer_id, default_currency_id
- **Уникальные ограничения**: internal_sku
- **Статусы**: draft, active, discontinued, archived
- **Связи**: product_identifiers, product_packaging, batches, shipment_items
- **Архивирование**: нельзя архивировать при inventory_balances.quantity_on_hand > 0
- **audit_log**: create, update, price_changed, status_changed

Изображения, документы и сертификаты товара хранятся как записи `documents` с `related_entity_type = 'product'` (см. раздел «Документы»); отдельная сущность для этого не создаётся, чтобы не дублировать модель документов.

### product_identifiers

Назначение: артикул поставщика, GTIN, штрихкод единицы, штрихкод короба.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → products.id |
| identifier_type | enum | да | supplier_sku / gtin / unit_barcode / box_barcode |
| value | text | да | |
| counterparty_id | uuid | нет | FK → counterparties.id (для supplier_sku) |
| is_primary | boolean | да | |

- **PK**: id · **FK**: product_id, counterparty_id
- **Уникальные ограничения**: (identifier_type, value) для gtin/unit_barcode/box_barcode; (product_id, counterparty_id, identifier_type) для supplier_sku
- **audit_log**: create, update, delete

### product_packaging

Назначение: логистическая упаковка — коэффициенты пересчёта единиц и физические параметры.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → products.id |
| uom | enum | да | piece / box / layer / pallet / truck |
| units_per_parent | integer | да | сколько единиц предыдущего уровня входит в эту |
| gross_weight_kg | numeric(10,3) | нет | |
| net_weight_kg | numeric(10,3) | нет | |
| volume_m3 | numeric(10,4) | нет | |
| length_cm / width_cm / height_cm | numeric(8,2) | нет | |

- **PK**: id · **FK**: product_id
- **Уникальные ограничения**: (product_id, uom)
- **audit_log**: create, update, delete

---

## 4. Склады и остатки

### warehouses

Назначение: справочник складов (Актобе — основной хаб, Астана, Алматы).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | |
| name | text | да | |
| city | text | нет | обязательно для физических складов |
| country | text | нет | обязательно для физических складов |
| is_main_hub | boolean | да | признак основного хаба (Актобе) |
| is_virtual | boolean | да | служебный склад без физического адреса (например, `IN_TRANSIT`) |
| address | text | нет | |
| status | enum | да | |

- **PK**: id · **Уникальные ограничения**: code
- **Статусы**: active, archived
- **Связи**: warehouse_locations, inventory_balances, inventory_movements
- **audit_log**: create, update, status_changed

### warehouse_locations

Назначение: ячейки/зоны хранения на складе.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| warehouse_id | uuid | да | FK → warehouses.id |
| code | text | да | |
| zone | enum | да | receiving / storage / picking / quarantine / shipping |
| temperature_regime | enum | нет | |
| status | enum | да | |

- **PK**: id · **FK**: warehouse_id
- **Уникальные ограничения**: (warehouse_id, code)
- **audit_log**: create, update, status_changed

### batches

Назначение: партии/серии товара со сроком годности — основа для FEFO и трассируемости.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → products.id |
| batch_number | text | да | внутренний номер партии |
| supplier_batch_number | text | нет | номер серии производителя |
| manufacture_date | date | нет | |
| expiry_date | date | да | |
| quantity_received | numeric(14,3) | да | в base_uom |
| incoming_shipment_id | uuid | нет | FK → shipments.id |
| status | enum | да | |
| quality_notes | text | нет | |

- **PK**: id · **FK**: product_id, incoming_shipment_id
- **Уникальные ограничения**: (product_id, batch_number, incoming_shipment_id)
- **Статусы**: active, quarantined, blocked (ручная блокировка), expired, depleted
- **Связи**: inventory_balances, inventory_movements, marking_codes, sticker_orders
- **Архивирование**: партии не архивируются — хранятся бессрочно для прослеживаемости; жизненный цикл отражается статусом
- **audit_log**: create, status_changed (особенно blocked/quarantined), expiry_updated

### inventory_balances

Назначение: агрегированный остаток по складу / ячейке / партии (производная таблица, пересчитывается на основе `inventory_movements`).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| warehouse_id | uuid | да | FK → warehouses.id |
| location_id | uuid | нет | FK → warehouse_locations.id |
| product_id | uuid | да | FK → products.id |
| batch_id | uuid | да | FK → batches.id |
| quantity_on_hand | numeric(14,3) | да | |
| quantity_reserved | numeric(14,3) | да | |
| uom | enum | да | base_uom товара |
| last_movement_at | timestamptz | нет | |

- **PK**: id · **FK**: warehouse_id, location_id, product_id, batch_id
- **Уникальные ограничения**: (warehouse_id, location_id, batch_id)
- **Архивирование**: не применимо (производная таблица; строки с нулевым остатком не удаляются, чтобы сохранить историю последнего движения)
- **audit_log**: не пишет напрямую — источник записей `inventory_movements`

### inventory_movements

Назначение: журнал складских движений (приход, расход, перемещение, списание, товар в пути и т.д.). Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| movement_type | enum | да | receipt / issue / transfer / write_off / return / adjustment / in_transit_start / in_transit_end |
| warehouse_id | uuid | да | FK → warehouses.id |
| location_id | uuid | нет | FK → warehouse_locations.id |
| product_id | uuid | да | FK → products.id |
| batch_id | uuid | да | FK → batches.id |
| quantity | numeric(14,3) | да | со знаком (приход +/ расход −) |
| uom | enum | да | |
| related_shipment_id | uuid | нет | FK → shipments.id |
| related_sale_id | uuid | нет | FK → sales.id |
| reason | text | нет | |
| performed_by | uuid | да | FK → employees.id |
| occurred_at | timestamptz | да | |
| reversal_of_id | uuid | нет | FK → inventory_movements.id (сторно) |
| transfer_group_id | uuid | нет | связывает две записи перемещения (расход со склада A + приход на склад B) |

- **PK**: id · **FK**: warehouse_id, location_id, product_id, batch_id, related_shipment_id, related_sale_id, performed_by, reversal_of_id
- **Перемещение**: оформляется парой записей (`transfer` с минусом на складе-отправителе и `transfer` с плюсом на складе-получателе) с общим `transfer_group_id`.
- **Товар в пути**: для него используется служебный склад `IN_TRANSIT` (запись в `warehouses` с отдельным кодом); `in_transit_start` переводит остаток на него, `in_transit_end` — на склад назначения. Так остатки «в пути» видны в тех же отчётах без отдельной таблицы.
- **Архивирование**: не удаляется никогда; исправление ошибок — только сторнирующей записью
- **audit_log**: создание движения фиксируется в audit_log как отдельное событие (create)

### inventory_reservations

Назначение: резервирование товара под заказ/отгрузку, включая логику FEFO (резерв может не быть привязан к конкретной партии — партия подбирается при отгрузке).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → products.id |
| batch_id | uuid | нет | FK → batches.id |
| warehouse_id | uuid | да | FK → warehouses.id |
| quantity | numeric(14,3) | да | |
| reserved_for_type | enum | да | sale / shipment / manual_block |
| reserved_for_id | uuid | да | полиморфная ссылка (без FK-ограничения) |
| status | enum | да | |
| expires_at | timestamptz | нет | |
| created_by | uuid | да | FK → employees.id |

- **PK**: id · **FK**: product_id, batch_id, warehouse_id, created_by
- **Статусы**: active, fulfilled, cancelled, expired
- **audit_log**: create, fulfilled, cancelled

---

## 5. Поставки и логистика

### shipments

Назначение: центральная сущность процесса — поставка от заказа производителю до закрытия (см. [`docs/process-rvi.md`](./process-rvi.md)).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_number | text | да | |
| project_code | text | нет | код проекта для группировки (например, Leib4-x); **«Требует подтверждения ARSEO»** |
| type | enum | да | import / export / domestic_transfer |
| carrier_id | uuid | нет | FK → carriers.id |
| vehicle_id | uuid | нет | FK → vehicles.id |
| supplier_id | uuid | условно | FK → counterparties.id (производитель/поставщик); обязательно для import |
| customer_id | uuid | условно | FK → counterparties.id; обязательно для export |
| route_id | uuid | да | FK → routes.id |
| contract_id | uuid | нет | FK → contracts.id |
| status | enum | да | высокоуровневый статус (см. process-rvi.md) |
| current_stage_id | uuid | нет | FK → shipment_stages.id |
| currency_id | uuid | да | FK → currencies.id |
| incoterms | text | нет | |
| planned_departure_date / planned_arrival_date | date | нет | |
| actual_departure_date / actual_arrival_date | date | нет | |
| destination_warehouse_id | uuid | да | FK → warehouses.id |
| responsible_employee_id | uuid | да | FK → employees.id |
| is_locked | boolean | да | закрытые/отменённые поставки блокируются от изменений |
| notes | text | нет | |

- **Правило**: одна запись `shipments` = одна перевозка (один автомобиль). Если заказ везут два автомобиля (как в пилоте), создаются две поставки с общим `project_code`. Так не нужна отдельная связующая таблица.
- **PK**: id · **FK**: supplier_id, customer_id, carrier_id, vehicle_id, route_id, contract_id, current_stage_id, currency_id, destination_warehouse_id, responsible_employee_id
- **Уникальные ограничения**: shipment_number
- **Статусы**: высокоуровневый `status` выводится из текущего этапа (`current_stage_id`) — planning, in_production, preparing_transport, in_transit, customs, receiving, sales, closed, а также on_hold и cancelled. Соответствие этапам и таблица переходов — в `process-rvi.md`.
- **Связи**: shipment_items, shipment_stage_history, expenses, documents (related_entity), batches.incoming_shipment_id
- **Архивирование**: closed/cancelled → is_locked = true, редактирование запрещено (кроме записи новых документов/комментариев)
- **audit_log**: create, update, status_changed, stage_changed, locked

### shipment_items

Назначение: позиции поставки.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK → shipments.id |
| product_id | uuid | да | FK → products.id |
| ordered_quantity | numeric(14,3) | да | |
| uom | enum | да | |
| unit_price | numeric(14,4) | нет | |
| currency_id | uuid | нет | FK → currencies.id |
| received_quantity | numeric(14,3) | нет | заполняется при приёмке |
| discrepancy_reason | text | нет | |
| batch_id | uuid | нет | FK → batches.id, после регистрации партии |

- **PK**: id · **FK**: shipment_id, product_id, currency_id, batch_id
- **Уникальные ограничения**: **«Требует подтверждения ARSEO»** — допустимы ли несколько строк на один товар в одной поставке (например, разные партии/цены)
- **audit_log**: create, update, receiving_updated

### shipment_stages

Назначение: справочник/шаблон этапов процесса (18 этапов пилота RVI, см. `process-rvi.md`); может быть специализирован по маршруту.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | системный код этапа |
| name_ru | text | да | |
| sequence_order | integer | да | |
| route_id | uuid | нет | FK → routes.id (null = общий этап) |
| sla_days | integer | нет | контрольный срок |
| is_active | boolean | да | |

- **PK**: id · **FK**: route_id
- **Уникальные ограничения**: (code, route_id)
- **audit_log**: create, update

### shipment_stage_history

Назначение: журнал фактических переходов поставки между этапами. Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK → shipments.id |
| stage_id | uuid | да | FK → shipment_stages.id |
| status | enum | да | entered / completed / skipped / blocked |
| entered_at | timestamptz | да | |
| completed_at | timestamptz | нет | |
| responsible_employee_id | uuid | да | FK → employees.id |
| comment | text | нет | |

- **PK**: id · **FK**: shipment_id, stage_id, responsible_employee_id
- **Архивирование**: не удаляется
- **audit_log**: каждая запись дублируется как событие в audit_log (stage_changed)

### routes

Назначение: справочник маршрутов.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| origin_country | text | да | |
| destination_country | text | да | |
| name | text | да | например «Финляндия → Казахстан» |
| typical_transit_days | integer | нет | |
| default_carrier_id | uuid | нет | FK → carriers.id |
| status | enum | да | |

- **PK**: id · **FK**: default_carrier_id
- **Уникальные ограничения**: (origin_country, destination_country) — **«Требует подтверждения ARSEO»**, если нужны несколько вариантов одного направления
- **audit_log**: create, update, status_changed

### carriers

Назначение: перевозчики — расширение `counterparties` для транспортных компаний.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → counterparties.id |
| transport_types | enum[] | нет | truck / rail / sea / air |
| license_number | text | нет | |
| notes | text | нет | |

- **PK**: id · **FK**: counterparty_id (1–1)
- **audit_log**: create, update

### vehicles

Назначение: транспортные средства для контроля температурного режима и перевозки.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| carrier_id | uuid | да | FK → carriers.id |
| plate_number | text | да | |
| vehicle_type | enum | да | truck / trailer / refrigerator |
| temperature_capability | text | нет | |
| driver_full_name | text | нет | **«Требует подтверждения ARSEO»** — допустимость хранения персональных данных водителя |
| driver_phone | text | нет | |
| status | enum | да | |

- **PK**: id · **FK**: carrier_id
- **Уникальные ограничения**: plate_number
- **audit_log**: create, update, status_changed

### brokers

Назначение: таможенные брокеры — расширение `counterparties`.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| counterparty_id | uuid | да | FK → counterparties.id |
| license_number | text | нет | |
| countries_serviced | text[] | нет | |
| notes | text | нет | |

- **PK**: id · **FK**: counterparty_id (1–1)
- **audit_log**: create, update

### customs_clearances

Назначение: таможенное оформление конкретной поставки.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK → shipments.id |
| broker_id | uuid | да | FK → brokers.id |
| declaration_number | text | нет | |
| country | text | да | |
| status | enum | да | |
| submitted_at | timestamptz | нет | |
| cleared_at | timestamptz | нет | |
| customs_value | numeric(14,2) | нет | |
| currency_id | uuid | нет | FK → currencies.id |
| duties_amount / fees_amount | numeric(14,2) | нет | |

- **PK**: id · **FK**: shipment_id, broker_id, currency_id
- **Статусы**: pending, submitted, in_progress, cleared, rejected, on_hold
- **audit_log**: create, update, status_changed

---

## 6. Документы

### documents

Назначение: метаданные документа; бинарный файл — в объектном хранилище.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| doc_type | enum | да | invoice / cmr / ttn / snt / waybill / packing_list / specification / contract / guarantee_letter / customs_doc / client_input_card / client_output_card / other |
| doc_number | text | нет | |
| doc_date | date | нет | |
| related_entity_type | enum | нет | shipment / contract / product / counterparty / customs_clearance |
| related_entity_id | uuid | нет | полиморфная ссылка |
| current_version_id | uuid | нет | FK → document_versions.id |
| status | enum | да | |
| created_by | uuid | да | FK → employees.id |

- **PK**: id · **FK**: current_version_id, created_by
- **Статусы**: draft, uploaded, under_review, approved, rejected, expired
- **Связи**: document_versions (1–N), approvals, document_templates (если сгенерирован по шаблону)
- **Архивирование**: не удаляется; is_archived после закрытия связанной поставки
- **audit_log**: create, upload_version, status_changed, approved, rejected, downloaded

### document_versions

Назначение: версии файла документа.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| document_id | uuid | да | FK → documents.id |
| version_number | integer | да | |
| file_name | text | да | |
| mime_type | text | да | |
| storage_key | text | да | ключ в объектном хранилище |
| file_size_bytes | bigint | нет | |
| checksum | text | нет | |
| validation_result | jsonb | нет | результат автоматической проверки |
| uploaded_by | uuid | да | FK → employees.id |
| uploaded_at | timestamptz | да | |

- **PK**: id · **FK**: document_id, uploaded_by
- **Уникальные ограничения**: (document_id, version_number)
- **Архивирование**: append-only, не удаляется
- **audit_log**: uploaded, downloaded

### document_templates

Назначение: шаблоны для автозаполнения документов.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| doc_type | enum | да | |
| name | text | да | |
| storage_key | text | да | |
| variables_schema | jsonb | да | список полей для подстановки |
| is_active | boolean | да | |
| created_by | uuid | да | FK → employees.id |

- **PK**: id · **FK**: created_by
- **Уникальные ограничения**: (doc_type, name)
- **audit_log**: create, update, deactivated

### approvals

Назначение: универсальные согласования (документов, поставок, расходов и т.д.).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| entity_type | enum | да | document / shipment / contract / expense / other |
| entity_id | uuid | да | полиморфная ссылка |
| approver_employee_id | uuid | да | FK → employees.id |
| requested_by | uuid | да | FK → employees.id |
| status | enum | да | |
| requested_at | timestamptz | да | |
| decided_at | timestamptz | нет | |
| comment | text | нет | |

- **PK**: id · **FK**: approver_employee_id, requested_by
- **Статусы**: pending, approved, rejected, cancelled
- **audit_log**: requested, approved, rejected, cancelled

---

## 7. Задачи и коммуникация

### tasks

Назначение: задачи/поручения, панель контроля задач и расхождений.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| title | text | да | |
| description | text | нет | |
| related_entity_type | text | нет | |
| related_entity_id | uuid | нет | |
| assignee_id | uuid | да | FK → employees.id |
| created_by | uuid | да | FK → employees.id |
| priority | enum | да | low / normal / high / urgent |
| due_date | date | нет | |
| status | enum | да | |

- **PK**: id · **FK**: assignee_id, created_by
- **Статусы**: open, in_progress, done, cancelled
- **audit_log**: create, update, status_changed, reassigned

### comments

Назначение: комментарии к сущностям (поставки, документы, задачи).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| entity_type | text | да | |
| entity_id | uuid | да | |
| author_id | uuid | да | FK → employees.id |
| body | text | да | |
| edited_at | timestamptz | нет | |

- **PK**: id · **FK**: author_id
- **audit_log**: create, edited, deleted

### notifications

Назначение: уведомления сотрудникам (сроки, согласования, расхождения).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| recipient_employee_id | uuid | да | FK → employees.id |
| type | enum | да | deadline / approval_request / status_change / discrepancy / system |
| title | text | да | |
| body | text | нет | |
| related_entity_type | text | нет | |
| related_entity_id | uuid | нет | |
| channel | enum | да | in_app / email / other — **«Требует подтверждения ARSEO»** какие каналы нужны |
| is_read | boolean | да | |
| read_at | timestamptz | нет | |

- **PK**: id · **FK**: recipient_employee_id
- **audit_log**: create (массовое чтение не логируется отдельно)

---

## 8. Финансы

### currencies

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | text | да | ISO 4217: KZT, RUB, EUR |
| name | text | да | |
| symbol | text | нет | |
| is_active | boolean | да | |

- **Уникальные ограничения**: code · **audit_log**: create, update

### exchange_rates

Назначение: курсы валют по датам и источникам (официальный / банковский). Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| base_currency_id | uuid | да | FK → currencies.id |
| quote_currency_id | uuid | да | FK → currencies.id |
| rate | numeric(18,6) | да | |
| source | enum | да | official / bank |
| rate_date | date | да | |

- **Уникальные ограничения**: (base_currency_id, quote_currency_id, source, rate_date)
- **Архивирование**: исторические курсы не удаляются
- **audit_log**: create

### expenses

Назначение: расходы, формирующие себестоимость.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | нет | FK → shipments.id |
| expense_type | enum | да | goods_cost / transport / logistics / broker_fee / customs_duty / tax / stickering / marking / bank_fee / other |
| amount | numeric(14,2) | да | |
| currency_id | uuid | да | FK → currencies.id |
| exchange_rate_id | uuid | нет | FK → exchange_rates.id |
| counterparty_id | uuid | нет | FK → counterparties.id |
| document_id | uuid | нет | FK → documents.id |
| incurred_at | date | да | |
| status | enum | да | |

- **PK**: id · **FK**: shipment_id, currency_id, exchange_rate_id, counterparty_id, document_id
- **Статусы**: draft, confirmed, allocated, paid
- **audit_log**: create, update, status_changed

### expense_allocations

Назначение: распределение расхода между товарами/партиями поставки.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| expense_id | uuid | да | FK → expenses.id |
| shipment_item_id | uuid | нет | FK → shipment_items.id |
| product_id | uuid | нет | FK → products.id |
| batch_id | uuid | нет | FK → batches.id |
| allocation_method | enum | да | by_quantity / by_weight / by_volume / by_value / manual |
| allocated_amount | numeric(14,2) | да | |
| currency_id | uuid | да | FK → currencies.id |

- **PK**: id · **FK**: expense_id, shipment_item_id, product_id, batch_id, currency_id
- **audit_log**: create, update, recalculated

### sales

Назначение: клиентские отгрузки (выручка + база для себестоимости и дебиторки).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| sale_number | text | да | |
| customer_id | uuid | да | FK → counterparties.id |
| shipment_id | uuid | нет | FK → shipments.id |
| currency_id | uuid | да | FK → currencies.id |
| sale_date | date | да | |
| status | enum | да | |
| total_amount | numeric(14,2) | да | |
| cost_amount | numeric(14,2) | нет | вычисляется из expense_allocations |

- **PK**: id · **FK**: customer_id, shipment_id, currency_id
- **Уникальные ограничения**: sale_number
- **Статусы**: draft, confirmed, shipped, invoiced, paid, cancelled
- **audit_log**: create, update, status_changed

### receivables

Назначение: дебиторская задолженность по продажам.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| sale_id | uuid | да | FK → sales.id |
| customer_id | uuid | да | FK → counterparties.id |
| currency_id | uuid | да | FK → currencies.id |
| amount_due | numeric(14,2) | да | |
| amount_paid | numeric(14,2) | да | |
| due_date | date | да | |
| status | enum | да | |
| last_payment_at | timestamptz | нет | |

- **PK**: id · **FK**: sale_id, customer_id, currency_id
- **Статусы**: open, partially_paid, paid, overdue, written_off
- **audit_log**: create, payment_recorded, status_changed, written_off

---

## 9. Маркировка и стикеровка

### sticker_templates

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| name | text | да | |
| product_id | uuid | нет | FK → products.id |
| layout | jsonb | да | |
| is_active | boolean | да | |
| created_by | uuid | да | FK → employees.id |

- **PK**: id · **FK**: product_id, created_by
- **audit_log**: create, update, deactivated

### sticker_orders

Назначение: заказы на изготовление/нанесение стикеров по партии (этап «Стикеровка» в Актобе).

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| shipment_id | uuid | да | FK → shipments.id |
| batch_id | uuid | да | FK → batches.id |
| sticker_template_id | uuid | да | FK → sticker_templates.id |
| quantity | numeric(14,3) | да | |
| status | enum | да | |
| requested_by | uuid | да | FK → employees.id |
| completed_at | timestamptz | нет | |

- **PK**: id · **FK**: shipment_id, batch_id, sticker_template_id, requested_by
- **Статусы**: planned, in_production, completed, cancelled
- **audit_log**: create, status_changed

### marking_codes

Назначение: коды маркировки «Честный знак» на единицу/короб товара.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| product_id | uuid | да | FK → products.id |
| batch_id | uuid | да | FK → batches.id |
| shipment_id | uuid | нет | FK → shipments.id |
| code_type | enum | да | unit / box |
| code_value | text | да | |
| status | enum | да | **«Требует подтверждения ARSEO»** — полный перечень статусов «Честного знака» |
| applied_at | timestamptz | нет | |

- **PK**: id · **FK**: product_id, batch_id, shipment_id
- **Уникальные ограничения**: code_value
- **Статусы (предварительно)**: issued, applied, shipped, sold, withdrawn
- **Архивирование**: не удаляется (юридически значимый след)
- **audit_log**: create, status_changed, applied

---

## 10. Интеграции

### integrations

Назначение: справочник внешних систем (Google Drive, Google Sheets, 1С). 1С — только источник данных: направление `inbound`, Nexus не изменяет данные в 1С.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| code | enum | да | google_drive / google_sheets / one_c |
| name | text | да | |
| direction | enum | да | inbound / outbound / bidirectional |
| config | jsonb | нет | конфигурация без секретов (секреты — в хранилище секретов/переменных окружения) |
| is_active | boolean | да | |

- **PK**: id · **Уникальные ограничения**: code
- **audit_log**: create, update, activated, deactivated

### synchronization_runs

Назначение: журнал запусков синхронизации + ошибки. Append-only.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| integration_id | uuid | да | FK → integrations.id |
| started_at | timestamptz | да | |
| finished_at | timestamptz | нет | |
| status | enum | да | running / success / failed / partial |
| records_processed | integer | да | |
| records_failed | integer | да | |
| error_summary | jsonb | нет | |
| triggered_by | enum | да | schedule / manual |

- **PK**: id · **FK**: integration_id
- **Архивирование**: не удаляется
- **audit_log**: manual-запуск фиксируется в общем audit_log отдельным событием

---

## 11. Аудит

### audit_log

Назначение: универсальный журнал действий пользователей и системы. Append-only, ничего не редактируется и не удаляется.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| id | uuid | да | PK |
| entity_type | text | да | |
| entity_id | uuid | да | полиморфная ссылка |
| action | text | да | например create, status_changed, approved |
| actor_employee_id | uuid | нет | FK → employees.id; null для системных/интеграционных действий |
| actor_type | enum | да | user / system / integration |
| occurred_at | timestamptz | да | |
| before_state | jsonb | нет | |
| after_state | jsonb | нет | |
| ip_address | text | нет | |

- **PK**: id · **FK**: actor_employee_id
- **Архивирование**: не удаляется; срок хранения (retention) — **«Требует подтверждения ARSEO»**
- **Какие действия попадают в журнал**: изменения прав доступа, статусов поставок/документов/партий, финансовые операции (создание/изменение расходов, списание дебиторки), согласования, вход/выход пользователей, ручная блокировка товара, запуск/ошибки интеграций — полный перечень указан в описании каждой сущности выше.

---

## Сводная схема связей (по доменам)

```
users ── employees ──< employee_roles >── roles ──< role_permissions >── permissions
employees ──< tasks / comments / notifications / shipment_stage_history

counterparties ──< counterparties_contacts
counterparties ──< contracts ──< contract_terms
counterparties ── carriers ──< vehicles
counterparties ── brokers
counterparties ──< product_identifiers (supplier_sku)

products ──< product_identifiers
products ──< product_packaging
products ──< batches ──< inventory_balances
batches ──< inventory_movements
batches ──< inventory_reservations
batches ──< marking_codes / sticker_orders

warehouses ──< warehouse_locations ──< inventory_balances / inventory_movements

routes ──< shipment_stages
shipments >── carriers / vehicles / routes / contracts
shipments ──< shipment_items
shipments ──< shipment_stage_history >── shipment_stages
shipments ──< customs_clearances ── brokers
shipments ──< expenses ──< expense_allocations
shipments ──< documents (related_entity)
shipments ── batches (incoming_shipment_id)

sales ──< receivables
sales ── shipments (опционально)

documents ──< document_versions
documents ── document_templates
documents ──< approvals (entity_type = document)

integrations ──< synchronization_runs

(*) audit_log и comments/notifications/approvals ссылаются полиморфно на большинство сущностей выше.
```
