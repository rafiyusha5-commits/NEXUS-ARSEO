-- Minimal privileges for the trusted pilot reference-data import job.
grant usage on schema public to service_role;
grant select on public.currencies to service_role;
grant select, insert on public.counterparties to service_role;
grant select, insert on public.products to service_role;
grant select, insert on public.product_identifiers to service_role;
