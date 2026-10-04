-- Froosh is a Fazer brand, not a separate factory in the ARSEO catalogue.
-- Keep the former counterparty for history, but move current master-data links to Fazer.
do $$
declare
  v_froosh uuid;
  v_fazer uuid;
begin
  select id into v_froosh
  from public.counterparties
  where lower(btrim(legal_name)) = 'froosh ab';

  if v_froosh is null then
    return;
  end if;

  select id into v_fazer
  from public.counterparties
  where lower(btrim(legal_name)) = 'fazer confectionary ltd';

  if v_fazer is null then
    raise exception 'Не найден завод Fazer Confectionary Ltd для переноса Froosh';
  end if;

  if exists (
    select 1
    from public.product_identifiers old_identifier
    join public.product_identifiers fazer_identifier
      on fazer_identifier.identifier_type = 'supplier_sku'
     and fazer_identifier.counterparty_id = v_fazer
     and fazer_identifier.value = old_identifier.value
     and fazer_identifier.id <> old_identifier.id
    where old_identifier.identifier_type = 'supplier_sku'
      and old_identifier.counterparty_id = v_froosh
  ) then
    raise exception 'Перенос Froosh остановлен: найден конфликт артикулов поставщика';
  end if;

  -- The supplier-sync trigger preserves the old Froosh link as inactive and
  -- creates or activates the Fazer relationship for every affected product.
  update public.products
  set manufacturer_id = v_fazer,
      updated_at = now()
  where manufacturer_id = v_froosh;

  update public.product_identifiers
  set counterparty_id = v_fazer
  where identifier_type = 'supplier_sku'
    and counterparty_id = v_froosh;

  -- Do not delete the former company: old shipments and audit history may refer to it.
  update public.counterparties
  set status = 'archived',
      archived_at = coalesce(archived_at, now()),
      updated_at = now()
  where id = v_froosh
    and status <> 'archived';
end $$;

comment on table public.product_suppliers is
  'Explicit supplier assortment; inactive rows preserve history, including former Froosh links moved to Fazer';
