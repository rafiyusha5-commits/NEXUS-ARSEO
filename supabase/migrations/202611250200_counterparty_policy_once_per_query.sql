-- Counterparty access is checked once per query, not once per row (performance measurement 25.11.2026).
-- The policies of 202609270002 call private.can_access_counterparty(action, roles): the call takes a column of the row,
-- so the planner runs it as a subplan for every row, and inside it private.has_permission (≈1.4 ms) runs again for each
-- row. 400 counterparties cost ≈0.5–0.65 s on every query that reads them, also when they are embedded (customer of an
-- order, payee of an expense) or when nothing is returned. Measured on a local stack with synthetic data: 19 pages got
-- 0.3–1.0 s faster.
-- The rule is the same as can_access_counterparty: a customer needs customers.<action>, a supplier, manufacturer,
-- carrier, broker, printing house or other party needs suppliers.<action>; either is enough for a party with several
-- roles. Only the permission checks move into the policy as uncorrelated subqueries, which PostgreSQL runs once per
-- statement. can_access_counterparty and can_access_counterparty_record stay for the functions that use them.
begin;

drop policy if exists "employees view permitted counterparties" on public.counterparties;
create policy "employees view permitted counterparties" on public.counterparties for select to authenticated using (
  ('customer' = any(roles) and (select private.has_permission('customers.view')))
  or (roles && array['manufacturer','supplier','carrier','broker','printing_house','other']
      and (select private.has_permission('suppliers.view'))));

drop policy if exists "employees create permitted counterparties" on public.counterparties;
create policy "employees create permitted counterparties" on public.counterparties for insert to authenticated with check (
  ('customer' = any(roles) and (select private.has_permission('customers.create')))
  or (roles && array['manufacturer','supplier','carrier','broker','printing_house','other']
      and (select private.has_permission('suppliers.create'))));

drop policy if exists "employees update permitted counterparties" on public.counterparties;
create policy "employees update permitted counterparties" on public.counterparties for update to authenticated using (
  ('customer' = any(roles) and (select private.has_permission('customers.update')))
  or (roles && array['manufacturer','supplier','carrier','broker','printing_house','other']
      and (select private.has_permission('suppliers.update'))))
with check (
  ('customer' = any(roles) and (select private.has_permission('customers.update')))
  or (roles && array['manufacturer','supplier','carrier','broker','printing_house','other']
      and (select private.has_permission('suppliers.update'))));

commit;
