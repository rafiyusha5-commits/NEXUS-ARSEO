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
14. `202609272200_shipment_tasks_notifications.sql` — shipment tasks (links to shipments and stages, status rules, `tasks.manage`) and in-app notifications for task assignment, deadlines, blocked stages and approvals, with idempotent deadline generation. See `docs/tasks-notifications.md`.

The browser never receives a service-role key. Authorization is enforced with PostgreSQL grants and RLS in addition to application checks.
