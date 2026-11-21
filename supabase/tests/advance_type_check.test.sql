-- 202611210100: an advance is set off only against an expense of its own kind (audit 2026-11-18, Н2).
-- Synthetic data only; everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ad100000-0000-4000-8000-000000000001','advance-type@example.invalid','{"full_name":"Advance type director"}');
insert into public.user_roles(user_id,role_id) select 'ad100000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ad110000-0000-4000-8000-000000000001',array['customer'],'Advance type customer','KZ','AD1-C'),
 ('ad110000-0000-4000-8000-000000000002',array['supplier','carrier'],'Advance type payee','KZ','AD1-P');
create temporary table ad1(k text primary key,id uuid);
grant all on ad1 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from ad1 where k=p_key $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Two confirmed expenses of one payee in EUR: goods 100 and transport (freight) 100.
with e as (
  insert into public.expenses(attributed_customer_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,is_planned,status,
                              confirmed_by,confirmed_at,created_by,notes)
  select 'ad110000-0000-4000-8000-000000000001',v.t,'ad110000-0000-4000-8000-000000000002',100,
         (select id from public.currencies where code='EUR'),current_date,false,'confirmed',
         'ad100000-0000-4000-8000-000000000001',now(),'ad100000-0000-4000-8000-000000000001',v.k
    from (values ('goods','goods_cost'),('freight','transport')) v(k,t)
  returning id, notes)
insert into ad1 select notes, id from e;

select set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into ad1 values
 ('adv_goods',public.record_advance_payment(gen_random_uuid(),'ad110000-0000-4000-8000-000000000002',(select id from public.currencies where code='EUR'),
   50,current_date,'goods')),
 ('adv_services',public.record_advance_payment(gen_random_uuid(),'ad110000-0000-4000-8000-000000000002',(select id from public.currencies where code='EUR'),
   50,current_date,'services'));

-- The two refusals.
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv_services'),pg_temp.id('goods'),10)$q$,
  'Аванс за услуги нельзя зачесть в расход за товар');
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv_goods'),pg_temp.id('freight'),10)$q$,
  'Аванс за товар нельзя зачесть в расход за услуги');
-- The allowed cases: goods into goods, services into freight.
select public.apply_advance(gen_random_uuid(),pg_temp.id('adv_goods'),pg_temp.id('goods'),30);
select public.apply_advance(gen_random_uuid(),pg_temp.id('adv_services'),pg_temp.id('freight'),20);
reset role;
do $$begin
 assert (select coalesce(sum(amount),0) from public.payment_applications where expense_id=pg_temp.id('goods'))=30,'goods: 30 from the goods advance';
 assert (select coalesce(sum(amount),0) from public.payment_applications where expense_id=pg_temp.id('freight'))=20,'freight: 20 from the services advance';
 assert not exists(select 1 from public.payment_applications a join public.payments p on p.id=a.payment_id
                    where a.expense_id=pg_temp.id('goods') and p.advance_for='services'),'the refused set-offs left nothing';
 assert private.payment_unapplied(pg_temp.id('adv_goods'))=20 and private.payment_unapplied(pg_temp.id('adv_services'))=30;
end $$;
\echo advance_type_check: all checks passed
rollback;
