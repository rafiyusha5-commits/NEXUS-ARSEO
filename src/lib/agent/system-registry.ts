// Fixed read-only registry. Table names, columns, predicates and permission codes never come from a model.
export type SystemSection = { key: string; title: string; table: string; permissions: string[]; anyPermissions: string[]; columns: string[]; search: string[]; date: string; parent: string; path: string; rpc: string | null; idColumn: string };
export const SYSTEM_SECTIONS: readonly SystemSection[] = [
  {
    "key": "products",
    "title": "Товары: состав, КБЖУ, срок годности и хранение",
    "table": "products",
    "permissions": [
      "products.view"
    ],
    "columns": [
      "id",
      "internal_sku",
      "name",
      "brand",
      "category",
      "country_of_origin",
      "composition",
      "nutrition_facts",
      "hs_code",
      "temperature_regime",
      "temperature_range",
      "shelf_life_days",
      "base_uom",
      "requires_marking",
      "requires_sticker",
      "status",
      "updated_at"
    ],
    "search": [
      "internal_sku",
      "name->>ru",
      "name->>en",
      "name->>kk",
      "brand"
    ],
    "date": "",
    "parent": "",
    "path": "/products",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "packaging",
    "title": "Упаковка: веса, размеры и количество",
    "table": "product_packaging",
    "permissions": [
      "products.view"
    ],
    "columns": [
      "id",
      "product_id",
      "uom",
      "units_per_parent",
      "gross_weight_kg",
      "net_weight_kg",
      "volume_m3",
      "length_cm",
      "width_cm",
      "height_cm"
    ],
    "search": [],
    "date": "",
    "parent": "product_id",
    "path": "/products",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "identifiers",
    "title": "Артикулы поставщика и штрихкоды",
    "table": "product_identifiers",
    "permissions": [
      "products.view"
    ],
    "columns": [
      "id",
      "product_id",
      "identifier_type",
      "value",
      "counterparty_id",
      "packaging_uom",
      "is_primary"
    ],
    "search": [
      "value"
    ],
    "date": "",
    "parent": "product_id",
    "path": "/products",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "product_suppliers",
    "title": "Поставщики конкретного товара",
    "table": "product_suppliers",
    "permissions": [
      "products.view"
    ],
    "columns": [
      "product_id",
      "supplier_id",
      "status",
      "is_primary"
    ],
    "search": [],
    "date": "",
    "parent": "product_id",
    "path": "/products",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "product_id"
  },
  {
    "key": "calculator",
    "title": "Данные мастер-калькулятора по товару",
    "table": "product_master_data",
    "permissions": [
      "products.view"
    ],
    "columns": [
      "product_id",
      "source_key",
      "source_row",
      "catalog_data",
      "sales_data",
      "imported_at"
    ],
    "search": [],
    "date": "imported_at",
    "parent": "product_id",
    "path": "/products",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "product_id"
  },
  {
    "key": "product_prices",
    "title": "Закупочная цена товара",
    "table": "products",
    "permissions": [
      "products.view",
      "prices.purchase.view"
    ],
    "columns": [
      "product_id",
      "base_purchase_price",
      "currency_id"
    ],
    "search": [],
    "date": "",
    "parent": "product_id",
    "path": "/products",
    "anyPermissions": [],
    "rpc": "my_product_purchase_prices",
    "idColumn": "product_id"
  },
  {
    "key": "counterparties",
    "title": "Контрагенты, клиенты, поставщики и производители",
    "table": "counterparties",
    "permissions": [],
    "columns": [
      "id",
      "legal_name",
      "short_name",
      "roles",
      "country",
      "website",
      "min_remaining_shelf_life_pct",
      "status",
      "updated_at"
    ],
    "search": [
      "legal_name",
      "short_name"
    ],
    "date": "",
    "parent": "",
    "path": "/counterparties",
    "anyPermissions": [
      "customers.view",
      "suppliers.view"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "contracts",
    "title": "Договоры",
    "table": "contracts",
    "permissions": [],
    "columns": [
      "id",
      "counterparty_id",
      "number",
      "type",
      "currency_id",
      "sign_date",
      "valid_from",
      "valid_to",
      "incoterms",
      "status",
      "notes"
    ],
    "search": [
      "number"
    ],
    "date": "sign_date",
    "parent": "counterparty_id",
    "path": "/counterparties",
    "anyPermissions": [
      "customers.view",
      "suppliers.view"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "contract_terms",
    "title": "Условия договора: сроки, цены и требования",
    "table": "contract_terms",
    "permissions": [],
    "columns": [
      "id",
      "contract_id",
      "term_type",
      "product_id",
      "value_numeric",
      "value_text",
      "valid_from",
      "valid_to"
    ],
    "search": [],
    "date": "",
    "parent": "contract_id",
    "path": "/counterparties",
    "anyPermissions": [
      "customers.view",
      "suppliers.view"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "warehouses",
    "title": "Склады",
    "table": "warehouses",
    "permissions": [
      "warehouses.view"
    ],
    "columns": [
      "id",
      "code",
      "name",
      "city",
      "country",
      "address",
      "is_main_hub",
      "is_virtual",
      "status"
    ],
    "search": [
      "code",
      "name->>ru",
      "city"
    ],
    "date": "",
    "parent": "",
    "path": "/warehouses",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "locations",
    "title": "Зоны и ячейки склада",
    "table": "warehouse_locations",
    "permissions": [
      "warehouses.view"
    ],
    "columns": [
      "id",
      "warehouse_id",
      "code",
      "zone",
      "temperature_regime",
      "status"
    ],
    "search": [
      "code"
    ],
    "date": "",
    "parent": "warehouse_id",
    "path": "/warehouses",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "routes",
    "title": "Маршруты",
    "table": "routes",
    "permissions": [
      "suppliers.view"
    ],
    "columns": [
      "id",
      "name",
      "origin_country",
      "destination_country",
      "via_countries",
      "typical_transit_days",
      "status"
    ],
    "search": [
      "name->>ru",
      "origin_country",
      "destination_country"
    ],
    "date": "",
    "parent": "",
    "path": "/routes",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "vehicles",
    "title": "Справочник автомобилей",
    "table": "vehicles",
    "permissions": [
      "suppliers.view"
    ],
    "columns": [
      "id",
      "carrier_id",
      "plate_number",
      "trailer_plate_number",
      "vehicle_type",
      "temperature_capability",
      "status"
    ],
    "search": [
      "plate_number",
      "trailer_plate_number"
    ],
    "date": "",
    "parent": "carrier_id",
    "path": "/suppliers",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "shipments",
    "title": "Поставки",
    "table": "shipments",
    "permissions": [
      "shipments.view"
    ],
    "columns": [
      "id",
      "shipment_number",
      "project_code",
      "type",
      "status",
      "supplier_id",
      "customer_id",
      "planned_ready_date",
      "planned_arrival_date",
      "responsible_user_id",
      "updated_at"
    ],
    "search": [
      "shipment_number",
      "project_code"
    ],
    "date": "planned_arrival_date",
    "parent": "supplier_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "shipment_items",
    "title": "Товары поставки, количества и распределение по машинам",
    "table": "shipment_items",
    "permissions": [
      "shipments.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "shipment_transport_id",
      "product_id",
      "uom",
      "ordered_quantity",
      "confirmed_quantity",
      "shipped_quantity",
      "received_quantity",
      "currency_id",
      "discrepancy_reason"
    ],
    "search": [],
    "date": "",
    "parent": "shipment_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "stages",
    "title": "Этапы поставки",
    "table": "shipment_stage_runs",
    "permissions": [
      "shipments.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "stage_id",
      "shipment_transport_id",
      "is_required",
      "status",
      "due_at",
      "started_at",
      "completed_at",
      "status_reason"
    ],
    "search": [],
    "date": "due_at",
    "parent": "shipment_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "customs",
    "title": "Таможенное оформление",
    "table": "customs_clearances",
    "permissions": [
      "shipments.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "shipment_transport_id",
      "country",
      "declaration_number",
      "status",
      "submitted_at",
      "cleared_at",
      "currency_id"
    ],
    "search": [
      "declaration_number"
    ],
    "date": "submitted_at",
    "parent": "shipment_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sales",
    "title": "Клиентские заказы и продажи",
    "table": "sales",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "sale_number",
      "customer_id",
      "contract_id",
      "warehouse_id",
      "sale_date",
      "planned_shipment_date",
      "currency_id",
      "status",
      "notes"
    ],
    "search": [
      "sale_number"
    ],
    "date": "planned_shipment_date",
    "parent": "customer_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sale_items",
    "title": "Позиции продаж и продажные цены",
    "table": "sale_items",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "sale_id",
      "product_id",
      "quantity",
      "uom",
      "unit_price",
      "required_shelf_life_pct"
    ],
    "search": [],
    "date": "",
    "parent": "sale_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "batches",
    "title": "Партии, даты изготовления и сроки годности",
    "table": "inventory_batches",
    "permissions": [
      "inventory.view"
    ],
    "columns": [
      "id",
      "product_id",
      "batch_number",
      "manufacture_date",
      "expiry_date",
      "received_at",
      "status",
      "status_reason",
      "source_shipment_item_id"
    ],
    "search": [
      "batch_number"
    ],
    "date": "expiry_date",
    "parent": "product_id",
    "path": "/inventory",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "balances",
    "title": "Остатки и резервы по партиям",
    "table": "inventory_balances",
    "permissions": [
      "inventory.view"
    ],
    "columns": [
      "id",
      "batch_id",
      "warehouse_id",
      "warehouse_location_id",
      "uom",
      "quantity_on_hand",
      "quantity_reserved",
      "updated_at"
    ],
    "search": [],
    "date": "",
    "parent": "batch_id",
    "path": "/inventory",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "movements",
    "title": "История движения товаров",
    "table": "inventory_movements",
    "permissions": [
      "inventory.view"
    ],
    "columns": [
      "id",
      "batch_id",
      "movement_type",
      "quantity",
      "uom",
      "reference",
      "reason",
      "from_warehouse_id",
      "to_warehouse_id",
      "created_at"
    ],
    "search": [
      "reference"
    ],
    "date": "created_at",
    "parent": "batch_id",
    "path": "/inventory/movements",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "tasks",
    "title": "Задачи",
    "table": "tasks",
    "permissions": [
      "tasks.view"
    ],
    "columns": [
      "id",
      "title",
      "description",
      "entity_type",
      "entity_id",
      "assignee_user_id",
      "priority",
      "due_at",
      "status",
      "created_at"
    ],
    "search": [
      "title"
    ],
    "date": "due_at",
    "parent": "entity_id",
    "path": "/tasks",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "notifications",
    "title": "Мои уведомления",
    "table": "notifications",
    "permissions": [
      "agent.use"
    ],
    "columns": [
      "id",
      "recipient_user_id",
      "type",
      "title",
      "body",
      "entity_type",
      "entity_id",
      "is_read",
      "created_at"
    ],
    "search": [
      "title"
    ],
    "date": "created_at",
    "parent": "",
    "path": "/notifications",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "documents",
    "title": "Журнал документов: реквизиты и статусы",
    "table": "documents",
    "permissions": [
      "documents.view"
    ],
    "columns": [
      "id",
      "title",
      "document_number",
      "document_type_id",
      "document_date",
      "valid_until",
      "status",
      "language",
      "current_version",
      "created_at"
    ],
    "search": [
      "title",
      "document_number"
    ],
    "date": "document_date",
    "parent": "",
    "path": "/documents",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "templates",
    "title": "Шаблоны документов",
    "table": "document_templates",
    "permissions": [
      "templates.view"
    ],
    "columns": [
      "id",
      "name",
      "language",
      "purpose",
      "status",
      "is_active",
      "current_version",
      "updated_at"
    ],
    "search": [
      "name"
    ],
    "date": "",
    "parent": "",
    "path": "/templates",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "listing_cards",
    "title": "Карты ввода и вывода товара",
    "table": "product_listing_cards",
    "permissions": [
      "listing_cards.view"
    ],
    "columns": [
      "id",
      "card_number",
      "version",
      "card_type",
      "title",
      "status",
      "effective_date",
      "counterparty_id"
    ],
    "search": [
      "card_number",
      "title"
    ],
    "date": "effective_date",
    "parent": "counterparty_id",
    "path": "/listing-cards",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "listing_items",
    "title": "Товары карты ввода/вывода",
    "table": "product_listing_card_items",
    "permissions": [
      "listing_cards.view"
    ],
    "columns": [
      "id",
      "card_id",
      "product_id",
      "required_quantity",
      "uom",
      "counterparty_sku",
      "price",
      "currency_id"
    ],
    "search": [],
    "date": "",
    "parent": "card_id",
    "path": "/listing-cards",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "stickers",
    "title": "Макеты стикеров",
    "table": "sticker_templates",
    "permissions": [
      "stickers.view"
    ],
    "columns": [
      "id",
      "name",
      "product_id",
      "customer_id",
      "sticker_level",
      "languages",
      "status",
      "current_version_id"
    ],
    "search": [
      "name"
    ],
    "date": "",
    "parent": "product_id",
    "path": "/stickers",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sticker_orders",
    "title": "Заказы печати стикеров",
    "table": "sticker_orders",
    "permissions": [
      "stickers.view"
    ],
    "columns": [
      "id",
      "order_number",
      "printing_house_id",
      "shipment_id",
      "status",
      "minimum_print_run",
      "ordered_at",
      "received_at"
    ],
    "search": [
      "order_number"
    ],
    "date": "ordered_at",
    "parent": "shipment_id",
    "path": "/stickers",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "marking",
    "title": "Заказы кодов маркировки",
    "table": "marking_code_orders",
    "permissions": [
      "marking.view"
    ],
    "columns": [
      "id",
      "order_number",
      "shipment_id",
      "product_id",
      "quantity_requested",
      "quantity_received",
      "quantity_applied",
      "code_type",
      "status",
      "requested_at",
      "received_at"
    ],
    "search": [
      "order_number"
    ],
    "date": "requested_at",
    "parent": "product_id",
    "path": "/stickers",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "forecasts",
    "title": "Прогнозы продаж",
    "table": "forecasts",
    "permissions": [
      "forecasts.view"
    ],
    "columns": [
      "id",
      "name",
      "scenario",
      "version",
      "horizon_start",
      "horizon_end",
      "granularity",
      "method",
      "status",
      "approved_at"
    ],
    "search": [
      "name"
    ],
    "date": "horizon_start",
    "parent": "",
    "path": "/forecasts",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "forecast_lines",
    "title": "Товарные строки прогнозов",
    "table": "forecast_lines",
    "permissions": [
      "forecasts.view",
      "forecasts.detail"
    ],
    "columns": [
      "id",
      "forecast_id",
      "product_id",
      "customer_id",
      "warehouse_id",
      "period_start",
      "base_quantity",
      "promo_uplift_quantity",
      "final_quantity",
      "comment"
    ],
    "search": [],
    "date": "period_start",
    "parent": "forecast_id",
    "path": "/forecasts",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "purchase_plans",
    "title": "Планы закупок",
    "table": "purchase_plans",
    "permissions": [
      "purchase_plans.view"
    ],
    "columns": [
      "id",
      "name",
      "forecast_id",
      "supplier_id",
      "version",
      "horizon_start",
      "horizon_end",
      "status",
      "approved_at"
    ],
    "search": [
      "name"
    ],
    "date": "horizon_start",
    "parent": "supplier_id",
    "path": "/purchase-plans",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "purchase_lines",
    "title": "Расчёт потребности и позиции закупок",
    "table": "purchase_plan_lines",
    "permissions": [
      "purchase_plans.view",
      "purchase_plans.detail"
    ],
    "columns": [
      "id",
      "purchase_plan_id",
      "product_id",
      "forecast_demand",
      "stock_on_hand",
      "stock_in_transit",
      "stock_reserved",
      "safety_stock",
      "expiring_before_sale",
      "suggested_quantity",
      "rounded_quantity",
      "approved_quantity",
      "planned_order_date",
      "shipment_id",
      "comment"
    ],
    "search": [],
    "date": "planned_order_date",
    "parent": "purchase_plan_id",
    "path": "/purchase-plans",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "programs",
    "title": "Коммерческие программы и акции",
    "table": "commercial_programs",
    "permissions": [
      "commercial_programs.view"
    ],
    "columns": [
      "id",
      "name",
      "kind",
      "customer_id",
      "version",
      "starts_on",
      "ends_on",
      "status",
      "sale_id"
    ],
    "search": [
      "name"
    ],
    "date": "starts_on",
    "parent": "customer_id",
    "path": "/commercial-programs",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "program_lines",
    "title": "Товары и условия коммерческой программы",
    "table": "commercial_program_lines",
    "permissions": [
      "commercial_programs.view",
      "commercial_programs.detail"
    ],
    "columns": [
      "id",
      "commercial_program_id",
      "product_id",
      "planned_quantity",
      "promo_uplift_quantity",
      "uom",
      "discount_pct",
      "target_unit_price",
      "currency_id",
      "remaining_shelf_life_pct",
      "required_shelf_life_pct",
      "comment"
    ],
    "search": [],
    "date": "",
    "parent": "commercial_program_id",
    "path": "/commercial-programs",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "expenses",
    "title": "Расходы и платежи",
    "table": "expenses",
    "permissions": [
      "finance.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "expense_type",
      "payee_counterparty_id",
      "amount",
      "currency_id",
      "incurred_at",
      "is_planned",
      "status",
      "confirmed_at",
      "paid_at",
      "notes"
    ],
    "search": [],
    "date": "incurred_at",
    "parent": "shipment_id",
    "path": "/finance",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "cost_calculations",
    "title": "Расчёты себестоимости",
    "table": "cost_calculations",
    "permissions": [
      "prices.purchase.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "version_number",
      "currency_id",
      "status",
      "goods_total",
      "expenses_total",
      "landed_total",
      "calculated_at",
      "approved_at"
    ],
    "search": [],
    "date": "calculated_at",
    "parent": "shipment_id",
    "path": "/finance",
    "anyPermissions": [
      "costing.view",
      "costing.view_assigned"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "cost_items",
    "title": "Себестоимость товара в расчёте",
    "table": "cost_calculation_items",
    "permissions": [
      "prices.purchase.view"
    ],
    "columns": [
      "id",
      "calculation_id",
      "shipment_item_id",
      "product_id",
      "quantity",
      "goods_amount",
      "allocated_expenses",
      "landed_amount",
      "unit_landed_cost",
      "currency_id"
    ],
    "search": [],
    "date": "",
    "parent": "calculation_id",
    "path": "/finance",
    "anyPermissions": [
      "costing.view",
      "costing.view_assigned"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "exchange_rates",
    "title": "Курсы валют",
    "table": "exchange_rates",
    "permissions": [
      "finance.view"
    ],
    "columns": [
      "id",
      "base_currency_id",
      "quote_currency_id",
      "rate",
      "source",
      "source_name",
      "rate_date"
    ],
    "search": [],
    "date": "rate_date",
    "parent": "",
    "path": "/finance",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "currencies",
    "title": "Валюты",
    "table": "currencies",
    "permissions": [
      "agent.use"
    ],
    "columns": [
      "id",
      "code",
      "name",
      "is_active"
    ],
    "search": [
      "code"
    ],
    "date": "",
    "parent": "",
    "path": "/finance",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "integrations",
    "title": "Состояние интеграций",
    "table": "integrations",
    "permissions": [
      "integrations.view"
    ],
    "columns": [
      "id",
      "code",
      "name",
      "direction",
      "is_active",
      "last_status",
      "last_run_at",
      "last_success_at"
    ],
    "search": [
      "code",
      "name"
    ],
    "date": "",
    "parent": "",
    "path": "/integrations",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sync_runs",
    "title": "История синхронизации",
    "table": "synchronization_runs",
    "permissions": [
      "integrations.view"
    ],
    "columns": [
      "id",
      "integration_id",
      "entity_type",
      "status",
      "started_at",
      "finished_at",
      "records_read",
      "records_created",
      "records_updated",
      "records_failed"
    ],
    "search": [],
    "date": "started_at",
    "parent": "integration_id",
    "path": "/integrations",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "audit",
    "title": "История изменений системы",
    "table": "audit_log",
    "permissions": [
      "audit.view"
    ],
    "columns": [
      "id",
      "action",
      "entity_type",
      "entity_id",
      "actor_user_id",
      "created_at"
    ],
    "search": [
      "action",
      "entity_type"
    ],
    "date": "created_at",
    "parent": "entity_id",
    "path": "/audit",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "calculator_finance",
    "title": "Финансовые исходные данные калькулятора",
    "table": "product_master_data",
    "permissions": [
      "products.view",
      "prices.purchase.view"
    ],
    "columns": [
      "product_id",
      "source_key",
      "source_row",
      "catalog_data",
      "sales_data",
      "imported_at"
    ],
    "search": [],
    "date": "imported_at",
    "parent": "product_id",
    "path": "/products",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "product_id"
  },
  {
    "key": "contacts",
    "title": "Контакты контрагентов",
    "table": "counterparties_contacts",
    "permissions": [],
    "columns": [
      "id",
      "counterparty_id",
      "full_name",
      "position",
      "phone",
      "whatsapp_phone",
      "email",
      "is_primary"
    ],
    "search": [
      "full_name"
    ],
    "parent": "counterparty_id",
    "path": "/counterparties",
    "rpc": null,
    "idColumn": "id",
    "date": "",
    "anyPermissions": [
      "customers.view",
      "suppliers.view"
    ]
  },
  {
    "key": "transports",
    "title": "Машины поставки и контакты водителя",
    "table": "shipment_transports",
    "permissions": [
      "shipments.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "sequence_no",
      "status",
      "vehicle_plate",
      "vehicle_make",
      "trailer_plate",
      "trailer_make",
      "carrier_name",
      "driver_name",
      "driver_phone",
      "planned_loading_date",
      "actual_loading_date",
      "planned_arrival_date",
      "actual_arrival_date",
      "temperature_setpoint"
    ],
    "search": [
      "vehicle_plate",
      "trailer_plate",
      "carrier_name"
    ],
    "parent": "shipment_id",
    "path": "/shipments",
    "rpc": null,
    "idColumn": "id",
    "date": "planned_loading_date",
    "anyPermissions": []
  },
  {
    "key": "document_amounts",
    "title": "Суммы документов",
    "table": "documents",
    "permissions": [
      "documents.view",
      "prices.purchase.view"
    ],
    "columns": [
      "id",
      "document_number",
      "amount",
      "currency_id",
      "document_date",
      "status"
    ],
    "search": [
      "document_number"
    ],
    "parent": "",
    "path": "/documents",
    "rpc": null,
    "idColumn": "id",
    "date": "document_date",
    "anyPermissions": []
  },
  {
    "key": "shipment_prices",
    "title": "Закупочные цены позиций поставки",
    "table": "shipment_items",
    "permissions": [
      "shipments.view",
      "prices.purchase.view"
    ],
    "columns": [
      "item_id",
      "unit_price",
      "shipment_id"
    ],
    "search": [],
    "parent": "shipment_id",
    "path": "/shipments",
    "rpc": "my_shipment_item_purchase_prices",
    "idColumn": "item_id",
    "date": "",
    "anyPermissions": []
  },
  {
    "key": "inventory_costs",
    "title": "Себестоимость партий товара",
    "table": "inventory_batches",
    "permissions": [
      "inventory.view",
      "prices.purchase.view"
    ],
    "columns": [
      "batch_id",
      "unit_landed_cost",
      "cost_uom",
      "cost_currency_id",
      "cost_currency_code",
      "cost_calculation_id",
      "cost_basis"
    ],
    "search": [],
    "parent": "product_id",
    "path": "/inventory",
    "rpc": "my_batch_landed_costs",
    "idColumn": "batch_id",
    "date": "",
    "anyPermissions": []
  },
  {
    "key": "calendar",
    "title": "Календарь плановых и фактических событий",
    "table": "shipments",
    "permissions": [
      "calendar.view",
      "shipments.view"
    ],
    "columns": [
      "source_id",
      "source_type",
      "shipment_id",
      "event_kind",
      "title",
      "planned_at",
      "actual_at",
      "event_status",
      "supplier_name",
      "customer_name",
      "route_name",
      "shipment_number",
      "responsible_name"
    ],
    "search": [
      "title",
      "shipment_number"
    ],
    "parent": "shipment_id",
    "path": "/calendar",
    "rpc": "my_shipment_calendar",
    "idColumn": "source_id",
    "date": "planned_at",
    "anyPermissions": []
  },
  {
    "key": "employees",
    "title": "Справочник сотрудников",
    "table": "profiles",
    "permissions": [
      "users.view"
    ],
    "columns": [
      "id",
      "full_name",
      "job_title",
      "is_active",
      "user_type",
      "locale"
    ],
    "search": [
      "full_name",
      "job_title"
    ],
    "parent": "",
    "path": "/admin/users",
    "rpc": null,
    "idColumn": "id",
    "date": "",
    "anyPermissions": []
  },
  {
    "key": "roles",
    "title": "Роли системы",
    "table": "app_roles",
    "permissions": [
      "roles.manage"
    ],
    "columns": [
      "id",
      "code",
      "name",
      "description",
      "audience",
      "is_enabled"
    ],
    "search": [
      "code",
      "name"
    ],
    "parent": "",
    "path": "/admin/roles",
    "rpc": null,
    "idColumn": "id",
    "date": "",
    "anyPermissions": []
  },
  {
    "key": "permissions",
    "title": "Справочник прав",
    "table": "permissions",
    "permissions": [
      "roles.manage"
    ],
    "columns": [
      "id",
      "code",
      "module",
      "action",
      "name",
      "description"
    ],
    "search": [
      "code",
      "name"
    ],
    "parent": "",
    "path": "/admin/roles",
    "rpc": null,
    "idColumn": "id",
    "date": "",
    "anyPermissions": []
  },
  {
    "key": "role_permissions",
    "title": "Права конкретной роли",
    "table": "role_permissions",
    "permissions": [
      "roles.manage"
    ],
    "columns": [
      "role_id",
      "permission_id",
      "granted"
    ],
    "search": [],
    "parent": "role_id",
    "path": "/admin/roles",
    "rpc": null,
    "idColumn": "role_id",
    "date": "",
    "anyPermissions": []
  },
  // Added 2026-11-21: tables the assistant could not see; permissions mirror their SELECT policies.
  {
    "key": "returns",
    "title": "Возвраты от покупателей",
    "table": "customer_returns",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "return_number",
      "sale_id",
      "customer_id",
      "warehouse_id",
      "status",
      "reason",
      "received_at",
      "cancelled_at",
      "cancellation_reason",
      "created_at"
    ],
    "search": [
      "return_number",
      "reason"
    ],
    "date": "received_at",
    "parent": "sale_id",
    "path": "/sales/returns",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "return_items",
    "title": "Строки возвратов: количество, причина и решение",
    "table": "customer_return_items",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "return_id",
      "sale_item_id",
      "batch_id",
      "quantity",
      "uom",
      "reason_code",
      "unit_price",
      "decision",
      "decision_note",
      "decided_at"
    ],
    "search": [],
    "date": "decided_at",
    "parent": "return_id",
    "path": "/sales/returns",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "reservations",
    "title": "Резервы товара под заказы",
    "table": "inventory_reservations",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "sale_item_id",
      "inventory_balance_id",
      "batch_id",
      "quantity",
      "uom",
      "sale_quantity",
      "remaining_shelf_life_pct",
      "status",
      "is_fefo_override",
      "override_reason",
      "created_at"
    ],
    "search": [],
    "date": "created_at",
    "parent": "sale_item_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "guarantee_letters",
    "title": "Гарантийные письма покупателям",
    "table": "guarantee_letters",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "letter_number",
      "customer_id",
      "sale_id",
      "reason",
      "status",
      "notes",
      "approved_at",
      "sent_at",
      "customer_decision_at",
      "created_at"
    ],
    "search": [
      "letter_number",
      "reason"
    ],
    "date": "created_at",
    "parent": "sale_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "guarantee_items",
    "title": "Товары гарантийных писем",
    "table": "guarantee_letter_items",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "guarantee_letter_id",
      "sale_item_id",
      "batch_id",
      "quantity",
      "remaining_shelf_life_pct",
      "required_shelf_life_pct"
    ],
    "search": [],
    "date": "",
    "parent": "guarantee_letter_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sale_price_changes",
    "title": "История цен строк заказов",
    "table": "sale_item_price_changes",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "sale_item_id",
      "sale_id",
      "kind",
      "previous_price",
      "previous_source",
      "new_price",
      "new_source",
      "reason",
      "changed_at"
    ],
    "search": [],
    "date": "changed_at",
    "parent": "sale_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sale_date_changes",
    "title": "Переносы даты отгрузки заказов",
    "table": "sale_shipment_date_changes",
    "permissions": [
      "sales.view"
    ],
    "columns": [
      "id",
      "sale_id",
      "previous_date",
      "new_date",
      "change_kind",
      "reason",
      "changed_at"
    ],
    "search": [],
    "date": "changed_at",
    "parent": "sale_id",
    "path": "/sales",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "sale_credit_decisions",
    "title": "Решения по кредиту при подтверждении заказа",
    "table": "sale_credit_decisions",
    "permissions": [],
    "columns": [
      "id",
      "sale_id",
      "reason",
      "decided_at"
    ],
    "search": [],
    "date": "decided_at",
    "parent": "sale_id",
    "path": "/sales",
    "anyPermissions": [
      "sales.view",
      "receivables.view"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "credit_terms",
    "title": "Кредитные условия клиентов: лимит и отсрочка",
    "table": "customer_credit_terms",
    "permissions": [
      "receivables.view"
    ],
    "columns": [
      "customer_id",
      "credit_limit",
      "limit_currency_id",
      "default_deferral_days",
      "updated_at"
    ],
    "search": [],
    "date": "updated_at",
    "parent": "customer_id",
    "path": "/finance/receivables",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "customer_id"
  },
  {
    "key": "balance_adjustments",
    "title": "Корректировки сальдо клиентов",
    "table": "customer_balance_adjustments",
    "permissions": [
      "receivables.view"
    ],
    "columns": [
      "id",
      "customer_id",
      "currency_id",
      "entry_date",
      "amount",
      "reason",
      "created_at"
    ],
    "search": [
      "reason"
    ],
    "date": "entry_date",
    "parent": "customer_id",
    "path": "/finance/receivables",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "opening_balances",
    "title": "Начальные остатки дебиторки",
    "table": "customer_opening_balances",
    "permissions": [
      "receivables.view"
    ],
    "columns": [
      "id",
      "customer_id",
      "currency_id",
      "as_of",
      "amount",
      "due_date",
      "contract_number",
      "superseded_at",
      "created_at"
    ],
    "search": [
      "contract_number"
    ],
    "date": "as_of",
    "parent": "customer_id",
    "path": "/finance/receivables",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "reconciliation_acts",
    "title": "Акты сверки с клиентами",
    "table": "customer_reconciliation_acts",
    "permissions": [
      "receivables.view"
    ],
    "columns": [
      "id",
      "customer_id",
      "currency_id",
      "as_of",
      "act_balance",
      "nexus_balance",
      "note",
      "created_at"
    ],
    "search": [],
    "date": "as_of",
    "parent": "customer_id",
    "path": "/finance/receivables",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "bank_imports",
    "title": "Загрузки банковских выписок",
    "table": "bank_statement_imports",
    "permissions": [
      "receivables.view"
    ],
    "columns": [
      "id",
      "file_name",
      "period_from",
      "period_to",
      "currency_id",
      "lines_total",
      "lines_new",
      "lines_matched",
      "created_at"
    ],
    "search": [
      "file_name"
    ],
    "date": "period_from",
    "parent": "",
    "path": "/finance/bank",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "bank_lines",
    "title": "Поступления из банка: строки выписки",
    "table": "bank_statement_lines",
    "permissions": [
      "receivables.view"
    ],
    "columns": [
      "id",
      "import_id",
      "doc_number",
      "doc_date",
      "amount",
      "currency_id",
      "payer_name",
      "purpose",
      "status",
      "customer_id",
      "sale_id",
      "matched_how",
      "note",
      "resolved_at"
    ],
    "search": [
      "doc_number",
      "payer_name",
      "purpose"
    ],
    "date": "doc_date",
    "parent": "customer_id",
    "path": "/finance/bank",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "expense_allocations",
    "title": "Распределение расходов по товарам и партиям",
    "table": "expense_allocations",
    "permissions": [
      "finance.view"
    ],
    "columns": [
      "id",
      "expense_id",
      "shipment_item_id",
      "batch_id",
      "allocation_method",
      "allocation_basis",
      "allocation_share",
      "allocated_amount",
      "currency_id",
      "created_at"
    ],
    "search": [],
    "date": "created_at",
    "parent": "expense_id",
    "path": "/finance",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "warehouse_documents",
    "title": "Складские документы: перемещения, списания, корректировки",
    "table": "inventory_operation_documents",
    "permissions": [
      "inventory.view"
    ],
    "columns": [
      "id",
      "document_number",
      "operation_type",
      "status",
      "document_date",
      "from_warehouse_id",
      "to_warehouse_id",
      "reference",
      "reason",
      "performed_by_name",
      "posted_at",
      "cancelled_at",
      "cancellation_reason",
      "created_at"
    ],
    "search": [
      "document_number",
      "reference",
      "reason"
    ],
    "date": "document_date",
    "parent": "from_warehouse_id",
    "path": "/inventory/movements",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "warehouse_document_lines",
    "title": "Строки складских документов",
    "table": "inventory_operation_lines",
    "permissions": [
      "inventory.view"
    ],
    "columns": [
      "id",
      "document_id",
      "source_balance_id",
      "batch_id",
      "from_location_id",
      "to_location_id",
      "uom",
      "quantity",
      "adjustment_direction",
      "notes"
    ],
    "search": [],
    "date": "",
    "parent": "document_id",
    "path": "/inventory/movements",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "transport_receipts",
    "title": "Приёмки машин на складе",
    "table": "shipment_transport_receipts",
    "permissions": [
      "shipments.view",
      "inventory.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "shipment_transport_id",
      "warehouse_id",
      "warehouse_location_id",
      "performed_by_name",
      "notes",
      "received_at"
    ],
    "search": [],
    "date": "received_at",
    "parent": "shipment_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "transport_receipt_items",
    "title": "Строки приёмки: ожидалось, принято, брак, недостача",
    "table": "shipment_transport_receipt_items",
    "permissions": [
      "shipments.view",
      "inventory.view"
    ],
    "columns": [
      "id",
      "receipt_id",
      "shipment_item_id",
      "expected_quantity",
      "accepted_quantity",
      "damaged_quantity",
      "shortage_quantity",
      "overage_quantity",
      "discrepancy_reason",
      "inventory_batch_id",
      "batch_number",
      "manufacture_date",
      "expiry_date"
    ],
    "search": [
      "batch_number"
    ],
    "date": "expiry_date",
    "parent": "receipt_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "milestones",
    "title": "Вехи поставок: план и факт",
    "table": "shipment_milestones",
    "permissions": [
      "calendar.view",
      "shipments.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "title",
      "kind",
      "planned_at",
      "actual_at",
      "notes",
      "is_cancelled"
    ],
    "search": [
      "title"
    ],
    "date": "planned_at",
    "parent": "shipment_id",
    "path": "/calendar",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "stage_history",
    "title": "История этапов поставок",
    "table": "shipment_stage_history",
    "permissions": [
      "shipments.view"
    ],
    "columns": [
      "id",
      "stage_run_id",
      "shipment_id",
      "from_status",
      "to_status",
      "performed_by_name",
      "reason",
      "created_at"
    ],
    "search": [],
    "date": "created_at",
    "parent": "shipment_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "stage_templates",
    "title": "Шаблон этапов поставки: порядок, сроки, ответственные",
    "table": "shipment_stages",
    "permissions": [],
    "columns": [
      "id",
      "process_template_id",
      "code",
      "name",
      "sequence_order",
      "requirement",
      "scope",
      "status_category",
      "default_responsible_role",
      "sla_days",
      "is_active"
    ],
    "search": [
      "code"
    ],
    "date": "",
    "parent": "process_template_id",
    "path": "/shipments",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "logist_proposals",
    "title": "Предложения Логиста по поставкам",
    "table": "logist_proposals",
    "permissions": [
      "shipments.view",
      "documents.view"
    ],
    "columns": [
      "id",
      "shipment_id",
      "kind",
      "title",
      "reason",
      "status",
      "decided_at",
      "decision_note",
      "created_at"
    ],
    "search": [
      "title"
    ],
    "date": "created_at",
    "parent": "shipment_id",
    "path": "/logist",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "approvals",
    "title": "Согласования: документы, поставки и другое",
    "table": "approvals",
    "permissions": [],
    "columns": [
      "id",
      "entity_type",
      "entity_id",
      "approver_role",
      "status",
      "requested_at",
      "decided_at",
      "comment",
      "request_comment"
    ],
    "search": [],
    "date": "requested_at",
    "parent": "entity_id",
    "path": "/",
    "anyPermissions": [
      "documents.view",
      "shipments.view"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "document_versions",
    "title": "Версии документов: файл, размер, текущая",
    "table": "document_versions",
    "permissions": [
      "documents.view"
    ],
    "columns": [
      "id",
      "document_id",
      "version_number",
      "original_filename",
      "mime_type",
      "file_size_bytes",
      "is_current",
      "comment",
      "uploaded_at"
    ],
    "search": [
      "original_filename"
    ],
    "date": "uploaded_at",
    "parent": "document_id",
    "path": "/documents",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "document_links",
    "title": "Связи документов с поставками, машинами и заказами",
    "table": "document_links",
    "permissions": [
      "documents.view"
    ],
    "columns": [
      "id",
      "document_id",
      "entity_type",
      "entity_id",
      "link_role",
      "note",
      "created_at",
      "removed_at"
    ],
    "search": [],
    "date": "created_at",
    "parent": "document_id",
    "path": "/documents",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "document_types",
    "title": "Виды документов",
    "table": "document_types",
    "permissions": [],
    "columns": [
      "id",
      "code",
      "name_ru",
      "name_en",
      "category",
      "is_required_by_default",
      "has_validity_period",
      "is_active"
    ],
    "search": [
      "code",
      "name_ru",
      "name_en"
    ],
    "date": "",
    "parent": "",
    "path": "/documents",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "document_requirements",
    "title": "Обязательные документы по маршрутам и этапам",
    "table": "document_requirements",
    "permissions": [],
    "columns": [
      "id",
      "document_type_id",
      "applies_to",
      "shipment_type",
      "stage_id",
      "route_id",
      "is_mandatory",
      "due_days",
      "due_description",
      "notes",
      "is_active"
    ],
    "search": [
      "due_description",
      "notes"
    ],
    "date": "",
    "parent": "document_type_id",
    "path": "/documents",
    "anyPermissions": [
      "documents.view",
      "documents.manage_requirements"
    ],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "carriers",
    "title": "Перевозчики: направления, рефрижераторы, условия оплаты",
    "table": "carriers",
    "permissions": [
      "suppliers.view"
    ],
    "columns": [
      "id",
      "counterparty_id",
      "transport_types",
      "has_refrigerated_fleet",
      "directions",
      "payment_terms",
      "directory_active",
      "inactive_reason",
      "notes"
    ],
    "search": [
      "notes",
      "payment_terms"
    ],
    "date": "",
    "parent": "counterparty_id",
    "path": "/freight",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  },
  {
    "key": "brokers",
    "title": "Таможенные брокеры",
    "table": "brokers",
    "permissions": [
      "suppliers.view"
    ],
    "columns": [
      "id",
      "counterparty_id",
      "countries_serviced",
      "notes"
    ],
    "search": [
      "notes"
    ],
    "date": "",
    "parent": "counterparty_id",
    "path": "/suppliers",
    "anyPermissions": [],
    "rpc": null,
    "idColumn": "id"
  }
];
export const SYSTEM_BY_KEY: ReadonlyMap<string, SystemSection> = new Map(SYSTEM_SECTIONS.map(section => [section.key, section]));
export const SYSTEM_PERMISSIONS = [...new Set(SYSTEM_SECTIONS.flatMap(section => [...section.permissions, ...section.anyPermissions]))];
export function sectionAllowed(section: SystemSection, grants: ReadonlySet<string>): boolean { return section.permissions.every(code => grants.has(code)) && (!section.anyPermissions.length || section.anyPermissions.some(code => grants.has(code))); }
