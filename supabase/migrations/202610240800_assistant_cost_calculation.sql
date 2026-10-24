-- Read-only cost preview followed by explicit native calculation; never approval.
begin;
alter table private.assistant_operations add column if not exists result_calculation_id uuid references public.cost_calculations(id);
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide','customer_return_cancel','expense_create','expense_confirm','expense_allocate','shipment_cost_calculate'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_cost(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_cost;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_cost;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_cost;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_cost;
 end if;
end $$;
create or replace function private.require_assistant_cost_access() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
 private.has_permission('agent.use') and private.has_permission('costing.view') and private.has_permission('costing.calculate')
 and private.has_permission('prices.purchase.view') and private.has_permission('finance.view')
 and private.has_permission('products.view') and private.has_permission('shipments.view') and private.has_permission('documents.view'))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;
-- Mirrors calculate_shipment_cost 202610200500, but performs only SELECTs.
-- Numeric casts use the native row type; confirmation compares every stored field.
create or replace function private.assistant_cost_numbers(p_shipment_id uuid,p_target_currency_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_lines jsonb:='[]'::jsonb;v_item public.cost_calculation_items;v_version integer;v_goods numeric;v_expenses numeric;v_goods_item numeric;v_exp_item numeric;r record;v_rate numeric;
 v_lost text;v_planned numeric;v_planned_without_rate integer;v_goods_allocated numeric;v_rate_date date;v_basis text;v_cost_qty numeric;v_cost_qty_basis text;
begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права рассчитывать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 if exists(select 1 from public.expenses where shipment_id=p_shipment_id and not is_planned and status in ('draft','confirmed')) then
  raise exception 'Подтвердите и распределите фактические расходы поставки или отмените ошибочные';end if;
 if exists(select 1 from public.expenses e join public.expense_allocations a on a.expense_id=e.id
  where e.shipment_id=p_shipment_id and not e.is_planned and e.status in ('allocated','paid') and a.currency_id<>p_target_currency_id) then
  raise exception 'Все расходы должны быть распределены в валюте расчёта';end if;
 if not exists(select 1 from public.shipment_items where shipment_id=p_shipment_id) then raise exception 'В поставке нет товаров';end if;
 -- An expense spread before the receipt may hold a share of an item that did not arrive; skipping that
 -- share would silently lose money, so the expense has to be allocated again.
 select string_agg(distinct pr.internal_sku,', ' order by pr.internal_sku) into v_lost
 from public.expense_allocations a join public.expenses e on e.id=a.expense_id
 join public.shipment_items i on i.id=a.shipment_item_id join public.products pr on pr.id=i.product_id
 where e.shipment_id=p_shipment_id and not e.is_planned and e.status in ('allocated','paid')
  and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)<=0;
 if v_lost is not null then raise exception 'Часть расходов распределена на позиции без прихода (%): распределите эти расходы заново',v_lost;end if;
 if not exists(select 1 from public.shipment_items where shipment_id=p_shipment_id
  and coalesce(received_quantity,shipped_quantity,confirmed_quantity,ordered_quantity)>0) then
  raise exception 'В поставке нет принятого товара: рассчитывать себестоимость не из чего';end if;
 select coalesce(max(version_number),0)+1 into v_version from public.cost_calculations where shipment_id=p_shipment_id;
 for r in select i.*,coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity) qty,pr.internal_sku
  from public.shipment_items i join public.products pr on pr.id=i.product_id
  where i.shipment_id=p_shipment_id and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)>0 order by i.id loop
  select nullif(sum(a.allocated_amount) filter(where e.expense_type='goods_cost'),0),coalesce(sum(a.allocated_amount) filter(where e.expense_type<>'goods_cost'),0)
  into v_goods_allocated,v_exp_item from public.expense_allocations a join public.expenses e on e.id=a.expense_id
  where a.shipment_item_id=r.id and not e.is_planned and e.status in ('allocated','paid');
  if v_goods_allocated is not null then
   -- Purchase obligations are separate from warehouse losses. Never divide the full
   -- documented purchase by only the good units received. Do not infer units from a payment amount.
   v_cost_qty:=coalesce(r.shipped_quantity,r.confirmed_quantity,r.ordered_quantity);
   v_cost_qty_basis:=case when r.shipped_quantity is not null then 'shipped' when r.confirmed_quantity is not null then 'confirmed' else 'ordered' end;
   if v_cost_qty is null or v_cost_qty<=0 then raise exception 'Укажите количество закупки для расчёта позиции %',r.internal_sku;end if;
   v_goods_item:=v_goods_allocated;v_rate:=null;v_rate_date:=null;v_basis:='expense';
  else
   v_cost_qty:=r.qty;
   v_cost_qty_basis:=case when r.received_quantity is not null then 'received'
    when r.shipped_quantity is not null then 'shipped'
    when r.confirmed_quantity is not null then 'confirmed' else 'ordered' end;
   if r.unit_price is null or r.currency_id is null then raise exception 'У позиции поставки не заполнена закупочная цена или валюта';end if;
   if r.currency_id=p_target_currency_id then
    v_rate_date:=(now() at time zone 'Asia/Almaty')::date;v_basis:='same_currency';
   else
    select d.rate_date,d.basis into v_rate_date,v_basis from private.shipment_item_rate_date(r.id) d;
   end if;
   select fr.rate into v_rate from private.finance_rate(r.currency_id,p_target_currency_id,v_rate_date) fr;
   if v_rate is null then
    raise exception 'Нет курса % → % на % для закупочной цены %: добавьте курс на эту дату или раньше',
     (select code from public.currencies where id=r.currency_id),(select code from public.currencies where id=p_target_currency_id),
     to_char(v_rate_date,'DD.MM.YYYY'),r.internal_sku;
   end if;
   v_goods_item:=round(r.qty*r.unit_price*v_rate,2);
  end if;
  v_item:=jsonb_populate_record(null::public.cost_calculation_items,jsonb_build_object(
   'shipment_item_id',r.id,'product_id',r.product_id,'quantity',r.qty,'goods_amount',v_goods_item,
   'allocated_expenses',v_exp_item,'landed_amount',round(v_goods_item+v_exp_item,2),
   'unit_landed_cost',round((v_goods_item+v_exp_item)/v_cost_qty,4),'currency_id',p_target_currency_id,
   'goods_rate',v_rate,'goods_rate_date',v_rate_date,'goods_rate_basis',v_basis,
   'cost_quantity',v_cost_qty,'cost_quantity_basis',v_cost_qty_basis));
  v_lines:=v_lines||jsonb_build_array(to_jsonb(v_item)-'id'-'calculation_id');

 end loop;
 select coalesce(sum((l->>'goods_amount')::numeric),0),coalesce(sum((l->>'allocated_expenses')::numeric),0) into v_goods,v_expenses from jsonb_array_elements(v_lines)l;
 select sum(round(e.amount*fr.rate,2)),count(*) filter(where fr.rate is null) into v_planned,v_planned_without_rate
 from public.expenses e left join lateral private.finance_rate(e.currency_id,p_target_currency_id,e.incurred_at) fr on true
 where e.shipment_id=p_shipment_id and e.is_planned and e.status not in ('cancelled','reversed') and e.expense_type<>'goods_cost';
 return jsonb_build_object('version',v_version,'goods_total',v_goods::numeric(14,2),'expenses_total',v_expenses::numeric(14,2),
 'landed_total',(v_goods+v_expenses)::numeric(14,2),'planned_total',v_planned::numeric(14,2),
 'planned_without_rate',v_planned_without_rate,'lines',v_lines);
end $$;
create or replace function private.assistant_cost_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.shipments;c public.currencies;n jsonb;stamp jsonb;products jsonb;k text;
begin
 perform private.require_assistant_cost_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_COST_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>2 or not p ?& array['shipment_id','target_currency_id'] then raise exception 'ASSISTANT_COST_INVALID';end if;
 foreach k in array array['shipment_id','target_currency_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'ASSISTANT_COST_INVALID';end if;
 end loop;
 select * into s from public.shipments where id=(p->>'shipment_id')::uuid;
 select * into c from public.currencies where id=(p->>'target_currency_id')::uuid;
 if s.id is null or s.status='cancelled' or c.is_active is not true then raise exception 'ASSISTANT_COST_STATE';end if;
 if (select count(*) from public.shipment_items where shipment_id=s.id) not between 1 and 200 then raise exception 'ASSISTANT_COST_LIMIT';end if;
 n:=private.assistant_cost_numbers(s.id,c.id);
 select jsonb_object_agg(pr.id::text,jsonb_build_object('name',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),'sku',pr.internal_sku))
 into products from public.products pr where pr.id in(select product_id from public.shipment_items where shipment_id=s.id);
 stamp:=jsonb_build_object('inputs',private.shipment_cost_inputs_digest(s.id),'shipment',to_jsonb(s),'currency',to_jsonb(c),
 'items',(select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i where shipment_id=s.id),
 'products',products,'versions',(select jsonb_agg(to_jsonb(cc) order by id) from public.cost_calculations cc where shipment_id=s.id));
 return n||jsonb_build_object('shipment_id',s.id,'shipment_number',s.shipment_number,'currency',c.code,'products',products,
 'item_units',(select jsonb_object_agg(id::text,uom) from public.shipment_items where shipment_id=s.id),
 'performer',(select full_name from public.profiles where id=auth.uid()),
 'excluded_count',(select count(*) from public.shipment_items where shipment_id=s.id and coalesce(received_quantity,shipped_quantity,confirmed_quantity,ordered_quantity)<=0),
 'approved_version',(select max(version_number) from public.cost_calculations where shipment_id=s.id and status='approved'),
 'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_COST_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='shipment_cost_calculate' then perform private.require_assistant_cost_access();
 else perform private.require_assistant_kind_before_cost(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='shipment_cost_calculate' then return private.assistant_cost_preview(p_payload);
 else return private.assistant_preview_before_cost(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_cost_calculate' then return private.review_assistant_before_cost(p_request_id);end if;
 perform private.require_assistant_cost_access();
 if r.result_calculation_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_calculation_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cost_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;v jsonb;cid uuid;actual jsonb;c public.cost_calculations;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_cost_calculate' then return private.confirm_assistant_before_cost(p_request_id,p_review_token);end if;
 perform private.require_assistant_cost_access();
 if r.result_calculation_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 lock table public.expenses,public.shipment_items,public.expense_allocations in exclusive mode;
 lock table public.documents,public.document_links,public.document_types,public.exchange_rates,public.products in share mode;
 perform 1 from public.shipments where id=(r.payload->>'shipment_id')::uuid for share;
 perform 1 from public.currencies where id=(r.payload->>'target_currency_id')::uuid for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_cost_access();
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cost_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  cid:=public.calculate_shipment_cost((r.payload->>'shipment_id')::uuid,(r.payload->>'target_currency_id')::uuid);
  select * into c from public.cost_calculations where id=cid;
  select jsonb_agg(to_jsonb(i)-'id'-'calculation_id' order by shipment_item_id) into actual from public.cost_calculation_items i where calculation_id=cid;
  if actual is distinct from v->'lines' or c.status<>'draft' or c.approved_by is not null or c.approved_at is not null
   or c.version_number<>(v->>'version')::integer or c.goods_total<>(v->>'goods_total')::numeric
   or c.expenses_total<>(v->>'expenses_total')::numeric or c.landed_total<>(v->>'landed_total')::numeric
   or c.planned_expenses_total is distinct from (v->>'planned_total')::numeric
   or c.planned_expenses_without_rate<>(v->>'planned_without_rate')::integer
  then raise exception 'Native cost differs from preview';end if;
 exception when others then raise exception 'ASSISTANT_COST_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_calculation_id=cid where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_cost(uuid,uuid),private.review_assistant_before_cost(uuid),
 private.require_assistant_kind_before_cost(text),private.assistant_preview_before_cost(text,jsonb),
 private.require_assistant_cost_access(),private.assistant_cost_numbers(uuid,uuid),private.assistant_cost_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
