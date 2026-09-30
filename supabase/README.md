# Supabase setup

1. Create a Supabase project for Nexus-ARSEO.
2. Run migrations from `supabase/migrations` in order using the Supabase CLI or SQL Editor.
3. Copy the Project URL and publishable key to `.env.local` using `.env.example`.
4. Create the first employee account in Supabase Auth. The database trigger creates a matching `profiles` row.
5. Assign the first administrator by inserting the matching user and `administrator` role into `user_roles` from the SQL Editor.
6. For invitations from the Nexus user-management screen, add the server-only `SUPABASE_SECRET_KEY` to `.env.local` and later to Vercel. A legacy `SUPABASE_SERVICE_ROLE_KEY` is also supported. Never prefix either key with `NEXT_PUBLIC_`, paste it into chat, or commit it.

Migration order:

1. `202609260001_identity_and_access.sql` — Supabase Auth profiles, roles and base RLS.
2. `202609270001_phase0_access_control.sql` — detailed permissions, personal overrides, access audit and admin safeguards.
3. `202609270002_phase1_reference_data.sql` — counterparties, products, warehouses, routes, currencies and Phase 1 RLS.
4. `202609270003_phase2_shipments.sql` — shipments, the 18-stage RVI process, stage history, tasks, approvals and notifications.
5. `202609270004_service_role_grants.sql` — minimal privileges for trusted server-side reference-data imports with the secret API key.
6. `202609271001_document_management.sql` — document registry, private files, versions, links and requirements.
7. `202609271200_inventory_fifo.sql` — batches, balances and controlled FIFO issue.
8. `202609271400_inventory_movements.sql` — warehouse transfers and write-offs.
9. `202609271600_document_approvals.sql` — version-bound document review and approval workflow.
10. `202609271700_document_templates_listing_cards.sql` — document templates with file versions, and product listing cards (input/output) with versions and items.
11. `202609271800_counterparty_template_directions.sql` — supplier input and buyer output template directions, with counterparty-specific listing cards.
12. `202609271900_reference_data_import.sql` — transactional, idempotent import of counterparties, products, identifiers and packaging (`public.import_reference_data`, dry-run by default), and one owner per global barcode. See `docs/reference-import.md`.
13. `202609272000_product_catalog_classification.sql` — product categories, initial catalogue classification and indexes for manufacturer, brand and category filters.
14. `202609272100_shipment_execution.sql` — atomic allocation of shipment items between vehicles, transport progress and controlled hold, resume and cancellation actions.
15. `202609272200_shipment_tasks_notifications.sql` — shipment tasks (links to shipments and stages, status rules, `tasks.manage`) and in-app notifications for task assignment, deadlines, blocked stages and approvals, with idempotent deadline generation. See `docs/tasks-notifications.md`.
16. `202609272300_database_security_hardening.sql` — fixes of the database security audit: no anon access, employees need a role, protected audit log and personal overrides, forgery-proof approvals, notifications that follow object permissions, shipment status, stages, transports and items only through RPCs (new `add_shipment_transport`). See `docs/security-audit.md`.
17. `202609272400_shipment_transport_receiving.sql` — one-time, atomic vehicle receiving: discrepancies, batches, inventory balances and movements, and automatic completion of warehouse receiving stages. See `docs/shipment-receiving.md`.
18. `202609272500_customer_orders_fefo.sql` — customer orders, atomic FEFO reservations, remaining shelf-life checks, controlled FEFO overrides and guarantee letters. See `docs/customer-orders-fefo.md`.
19. `202609272600_stickers_marking.sql` — customer-specific sticker layouts with approval, print-run calculation and application accounting, plus marking-code orders. See `docs/stickers-marking.md`.
20. `202609272700_finance_costing.sql` — append-only exchange rates, shipment expenses, controlled allocation and versioned landed-cost approval. See `docs/finance-costing.md`.
21. `202609272800_integration_registry.sql` — safe integration registry, server-written synchronization journal, errors and manual mappings. See `docs/integrations.md`.
22. `202609272900_operational_analytics.sql` — permission gate for RLS-preserving operational analytics. See `docs/operational-analytics.md`.
23. `202609273000_sales_forecasts.sql` — versioned sales forecasts by product, customer, warehouse and period, with commercial review and final approval. See `docs/sales-forecasts.md`.
24. `202609273100_purchase_plans.sql` — versioned supplier purchase plans with packaging rounding, two-step approval and controlled creation of an RVI shipment. See `docs/purchase-plans.md`.
25. `202609273200_commercial_programs.sql` — versioned promotions, special customer orders and exact-batch low-shelf-life clearance, linked to forecasts and customer orders. See `docs/commercial-programs.md`.
26. `202609273300_external_client_portal.sql` — isolated customer document portal, explicit per-client sharing, external account permissions and audited access.
27. `202609273400_shipment_calendar.sql` — unified shipment calendar, plan/fact deviations and additional controlled milestones. See `docs/shipment-calendar.md`.
28. `202609273500_document_generation.sql` — protected DOCX generation from approved shipment templates with an immutable input snapshot. See `docs/document-generation.md`.
29. `202609273600_source_document_extraction.sql` — version-bound extraction and exception review for uploaded shipment sources, plus protected XLSX output generation. See `docs/source-document-extraction.md`.
30. `202609273700_export_document_package.sql` — selected export package generation: filled shipment workbook plus printable CMR, ТТН and packing-list PDFs with one immutable source snapshot.

The browser never receives a service-role key. Authorization is enforced with PostgreSQL grants and RLS in addition to application checks.
