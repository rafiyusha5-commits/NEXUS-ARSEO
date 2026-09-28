-- Phase 4C: sticker layouts, print orders and product marking.

insert into public.permissions(code,module,action,name,description) values
  ('stickers.view','stickers','view','Стикеры: просмотр','Просмотр макетов и заказов стикеров'),
  ('stickers.design','stickers','design','Стикеры: макеты','Создание версий макетов и отправка на согласование'),
  ('stickers.approve','stickers','approve','Стикеры: согласование','Утверждение и отклонение версий макетов'),
  ('stickers.order','stickers','order','Стикеры: заказы','Расчёт и заказ печати стикеров'),
  ('stickers.apply','stickers','apply','Стикеры: нанесение','Учёт нанесённых и испорченных стикеров'),
  ('marking.view','marking','view','Маркировка: просмотр','Просмотр заказов кодов маркировки'),
  ('marking.manage','marking','manage','Маркировка: управление','Заказ кодов и учёт их нанесения')
on conflict(code) do update set name=excluded.name,description=excluded.description;

insert into public.document_types(code,name_ru,name_en,name_kk,category,is_required_by_default,has_validity_period,sort_order) values
 ('sticker_layout','Макет стикера','Sticker layout','Стикер макеті','marking',false,false,141),
 ('marking_codes_file','Файл кодов маркировки','Marking codes file','Таңбалау кодтары файлы','marking',false,false,142)
on conflict(code) do nothing;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p where
 (p.code in ('stickers.view','marking.view') and r.code in ('administrator','director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','marketer'))
 or (p.code='stickers.design' and r.code in ('administrator','director','marketer'))
 or (p.code='stickers.approve' and r.code in ('director','commercial_director','logistics_director'))
 or (p.code in ('stickers.order','marking.manage') and r.code in ('administrator','director','logistics_director','senior_logistics_manager'))
 or (p.code='stickers.apply' and r.code in ('administrator','director','senior_logistics_manager','logistics_specialist'))
on conflict(role_id,permission_id) do update set granted=excluded.granted;

create table if not exists public.sticker_templates(
 id uuid primary key default gen_random_uuid(), name text not null check(length(btrim(name)) between 1 and 200),
 product_id uuid references public.products(id) on delete restrict, customer_id uuid references public.counterparties(id) on delete restrict,
 sticker_level text not null check(sticker_level in ('unit','box')), languages text[] not null check(cardinality(languages)>0),
 current_version_id uuid, status text not null default 'active' check(status in ('active','archived')),
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),archived_at timestamptz,
 check(product_id is not null or customer_id is not null)
);
create table if not exists public.sticker_template_versions(
 id uuid primary key default gen_random_uuid(),sticker_template_id uuid not null references public.sticker_templates(id) on delete restrict,
 version_number integer not null check(version_number>0),content jsonb not null check(jsonb_typeof(content)='object'),
 layout_document_id uuid not null references public.documents(id) on delete restrict,
 status text not null default 'draft' check(status in ('draft','in_review','approved','rejected','superseded')),
 decision_comment text,created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),submitted_at timestamptz,approved_by uuid references public.profiles(id) on delete restrict,approved_at timestamptz,
 unique(sticker_template_id,version_number),
 check(status<>'rejected' or nullif(btrim(decision_comment),'') is not null)
);
do $$ begin alter table public.sticker_templates add constraint sticker_templates_current_version_fk foreign key(current_version_id) references public.sticker_template_versions(id) on delete restrict; exception when duplicate_object then null; end $$;
create unique index if not exists sticker_templates_scope_unique on public.sticker_templates(coalesce(product_id,'00000000-0000-0000-0000-000000000000'),coalesce(customer_id,'00000000-0000-0000-0000-000000000000'),sticker_level) where status='active';

create sequence if not exists public.sticker_order_number_seq;
create table if not exists public.sticker_orders(
 id uuid primary key default gen_random_uuid(),order_number text not null unique,printing_house_id uuid references public.counterparties(id) on delete restrict,
 shipment_id uuid not null references public.shipments(id) on delete restrict,status text not null default 'calculated' check(status in ('draft','calculated','ordered','received','applied','cancelled')),
 minimum_print_run integer not null default 1 check(minimum_print_run>0),ordered_at timestamptz,received_at timestamptz,document_id uuid references public.documents(id) on delete restrict,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.sticker_order_items(
 id uuid primary key default gen_random_uuid(),sticker_order_id uuid not null references public.sticker_orders(id) on delete restrict,
 shipment_item_id uuid not null references public.shipment_items(id) on delete restrict,sticker_template_version_id uuid not null references public.sticker_template_versions(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,batch_id uuid references public.inventory_batches(id) on delete restrict,
 units_to_label numeric(14,3) not null check(units_to_label>0),actual_units_to_label numeric(14,3),reserve_pct numeric(5,2) not null check(reserve_pct between 0 and 100),
 calculated_quantity integer not null check(calculated_quantity>0),ordered_quantity integer not null check(ordered_quantity>=calculated_quantity),received_quantity integer not null default 0 check(received_quantity>=0),
 applied_quantity integer not null default 0 check(applied_quantity>=0),spoiled_quantity integer not null default 0 check(spoiled_quantity>=0),applied_by_name text,
 render_data_snapshot jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(sticker_order_id,shipment_item_id)
);

create sequence if not exists public.marking_order_number_seq;
create table if not exists public.marking_code_orders(
 id uuid primary key default gen_random_uuid(),order_number text not null unique,partner_id uuid references public.counterparties(id) on delete restrict,
 shipment_id uuid references public.shipments(id) on delete restrict,product_id uuid not null references public.products(id) on delete restrict,
 quantity_requested integer not null check(quantity_requested>0),quantity_received integer not null default 0 check(quantity_received>=0),quantity_applied integer not null default 0 check(quantity_applied>=0),
 code_type text not null check(code_type in ('unit','box')),status text not null default 'draft' check(status in ('draft','requested','received','partially_applied','applied','cancelled')),
 codes_document_id uuid references public.documents(id) on delete restrict,requested_at timestamptz,received_at timestamptz,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.marking_codes(
 id uuid primary key default gen_random_uuid(),marking_code_order_id uuid not null references public.marking_code_orders(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,batch_id uuid references public.inventory_batches(id) on delete restrict,shipment_id uuid references public.shipments(id) on delete restrict,
 code_type text not null check(code_type in ('unit','box')),code_value text not null unique,status text not null default 'issued' check(status in ('issued','applied','shipped','withdrawn')),
 applied_at timestamptz,created_at timestamptz not null default now()
);

do $$ declare t text; begin foreach t in array array['sticker_templates','sticker_template_versions','sticker_orders','sticker_order_items','marking_code_orders','marking_codes'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('drop policy if exists "permitted read" on public.%I',t);
 execute format('create policy "permitted read" on public.%I for select to authenticated using ((select private.has_permission(%L)))',t,case when t like 'marking%%' then 'marking.view' else 'stickers.view' end);
 end loop; end $$;
drop policy if exists "permitted read" on public.marking_codes;
create policy "permitted read" on public.marking_codes for select to authenticated using ((select private.has_permission('marking.manage')));
revoke all on sequence public.sticker_order_number_seq,public.marking_order_number_seq from public,anon,authenticated;

-- If a newly added shipment item requires a sticker and no approved customer-specific
-- or generic layout exists, create one deduplicated task for a marketer. The ordinary
-- task trigger delivers the in-app notification without exposing product data elsewhere.
create or replace function private.create_missing_sticker_task()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_customer uuid;v_marketer uuid;v_stage_run uuid;v_sku text;v_creator uuid;
begin
 if not exists(select 1 from public.products where id=new.product_id and requires_sticker) then return null;end if;
 select s.customer_id,s.created_by,p.internal_sku into v_customer,v_creator,v_sku from public.shipments s cross join public.products p where s.id=new.shipment_id and p.id=new.product_id;
 if exists(select 1 from public.sticker_templates t join public.sticker_template_versions v on v.id=t.current_version_id where t.product_id=new.product_id and t.status='active' and v.status='approved' and (t.customer_id=v_customer or t.customer_id is null)) then return null;end if;
 if exists(select 1 from public.tasks where entity_type='sticker_layout' and entity_id=new.product_id and shipment_id=new.shipment_id and status in ('open','in_progress')) then return null;end if;
 select p.id into v_marketer from public.profiles p join public.user_roles ur on ur.user_id=p.id join public.app_roles r on r.id=ur.role_id where p.is_active and r.code='marketer' order by p.created_at limit 1;
 if v_marketer is null then return null;end if;
 select run.id into v_stage_run from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=new.shipment_id and st.code='stickering' limit 1;
 insert into public.tasks(title,description,entity_type,entity_id,assignee_user_id,created_by,priority,shipment_id,stage_run_id)
 values('Подготовить макет стикера: '||v_sku,'Для товара поставки нет утверждённого общего или клиентского макета.','sticker_layout',new.product_id,v_marketer,v_creator,'high',new.shipment_id,v_stage_run);
 return null;
end $$;
drop trigger if exists create_missing_sticker_task on public.shipment_items;
create trigger create_missing_sticker_task after insert or update of product_id on public.shipment_items for each row execute function private.create_missing_sticker_task();
revoke all on function private.create_missing_sticker_task() from public,anon,authenticated,service_role;

create or replace function public.create_sticker_template(p_name text,p_product_id uuid,p_customer_id uuid,p_sticker_level text,p_languages text[],p_content jsonb,p_layout_document_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$ declare v_template uuid; begin
 if not (select private.has_permission('stickers.design')) then raise exception 'Нет права создавать макеты стикеров'; end if;
 if nullif(btrim(p_name),'') is null or p_sticker_level not in ('unit','box') or cardinality(p_languages)=0 then raise exception 'Заполните название, уровень и языки'; end if;
 if p_product_id is null and p_customer_id is null then raise exception 'Выберите товар или клиента'; end if;
 if not exists(select 1 from public.documents where id=p_layout_document_id and archived_at is null) then raise exception 'Файл макета не найден в документах'; end if;
 insert into public.sticker_templates(name,product_id,customer_id,sticker_level,languages) values(trim(p_name),p_product_id,p_customer_id,p_sticker_level,p_languages) returning id into v_template;
 insert into public.sticker_template_versions(sticker_template_id,version_number,content,layout_document_id) values(v_template,1,coalesce(p_content,'{}'::jsonb),p_layout_document_id);
 return v_template;
end $$;

create or replace function public.add_sticker_template_version(p_template_id uuid,p_content jsonb,p_layout_document_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$ declare v_id uuid; begin
 if not (select private.has_permission('stickers.design')) then raise exception 'Нет права изменять макеты стикеров'; end if;
 if not exists(select 1 from public.sticker_templates where id=p_template_id and status='active' for update) then raise exception 'Макет не найден'; end if;
 if not exists(select 1 from public.documents where id=p_layout_document_id and archived_at is null) then raise exception 'Файл макета не найден'; end if;
 insert into public.sticker_template_versions(sticker_template_id,version_number,content,layout_document_id)
 select p_template_id,coalesce(max(version_number),0)+1,coalesce(p_content,'{}'::jsonb),p_layout_document_id from public.sticker_template_versions where sticker_template_id=p_template_id returning id into v_id;return v_id;
end $$;

create or replace function public.submit_sticker_template_version(p_version_id uuid)
returns void language plpgsql security definer set search_path='' as $$ begin
 if not (select private.has_permission('stickers.design')) then raise exception 'Нет права отправлять макет'; end if;
 update public.sticker_template_versions set status='in_review',submitted_at=now() where id=p_version_id and status='draft';if not found then raise exception 'Отправить можно только черновик'; end if;
end $$;

create or replace function public.decide_sticker_template_version(p_version_id uuid,p_approved boolean,p_comment text)
returns void language plpgsql security definer set search_path='' as $$ declare v_template uuid; begin
 if not (select private.has_permission('stickers.approve')) then raise exception 'Нет права согласовывать макеты'; end if;
 select sticker_template_id into v_template from public.sticker_template_versions where id=p_version_id and status='in_review' for update;if not found then raise exception 'Версия не находится на согласовании'; end if;
 if not p_approved and nullif(btrim(p_comment),'') is null then raise exception 'Укажите причину отклонения'; end if;
 if p_approved then
  update public.sticker_template_versions set status='superseded' where sticker_template_id=v_template and status='approved';
  update public.sticker_template_versions set status='approved',approved_by=auth.uid(),approved_at=now(),decision_comment=nullif(btrim(p_comment),'') where id=p_version_id;
  update public.sticker_templates set current_version_id=p_version_id,updated_at=now() where id=v_template;
  update public.tasks task set status='done',completed_at=now(),updated_at=now()
  where task.entity_type='sticker_layout' and task.entity_id=(select product_id from public.sticker_templates where id=v_template)
    and task.status in ('open','in_progress') and exists(
      select 1 from public.shipments shipment where shipment.id=task.shipment_id
        and ((select customer_id from public.sticker_templates where id=v_template) is null
          or shipment.customer_id=(select customer_id from public.sticker_templates where id=v_template)));
 else update public.sticker_template_versions set status='rejected',approved_by=auth.uid(),approved_at=now(),decision_comment=btrim(p_comment) where id=p_version_id;end if;
end $$;

create or replace function public.create_sticker_order(p_shipment_id uuid,p_printing_house_id uuid,p_reserve_pct numeric,p_minimum_print_run integer)
returns uuid language plpgsql security definer set search_path='' as $$ declare v_id uuid;v_customer uuid;r record;v_version uuid;v_units numeric;v_calc integer;begin
 if not (select private.has_permission('stickers.order')) then raise exception 'Нет права заказывать стикеры'; end if;
 if p_reserve_pct<0 or p_reserve_pct>100 or p_minimum_print_run<1 then raise exception 'Некорректный запас или тираж'; end if;
 select customer_id into v_customer from public.shipments where id=p_shipment_id and status<>'cancelled' for update;if not found then raise exception 'Поставка не найдена';end if;
 if p_printing_house_id is not null and not exists(select 1 from public.counterparties where id=p_printing_house_id and 'printing_house'=any(roles) and status='active') then raise exception 'Типография не найдена';end if;
 if exists(select 1 from public.sticker_orders where shipment_id=p_shipment_id and status<>'cancelled') then raise exception 'Для поставки уже есть активный заказ стикеров';end if;
 insert into public.sticker_orders(order_number,printing_house_id,shipment_id,minimum_print_run) values(format('ST-%s-%s',extract(year from current_date)::int,lpad(nextval('public.sticker_order_number_seq')::text,6,'0')),p_printing_house_id,p_shipment_id,p_minimum_print_run) returning id into v_id;
 for r in select i.id,i.product_id,coalesce(i.confirmed_quantity,i.ordered_quantity) units,p.name,p.internal_sku from public.shipment_items i join public.products p on p.id=i.product_id where i.shipment_id=p_shipment_id and p.requires_sticker loop
  select v.id into v_version from public.sticker_templates t join public.sticker_template_versions v on v.id=t.current_version_id where t.product_id=r.product_id and t.status='active' and t.sticker_level='unit' and (t.customer_id=v_customer or t.customer_id is null) and v.status='approved' order by (t.customer_id is not null) desc limit 1;
  if v_version is null then raise exception 'Для товара % нет утверждённого макета',r.internal_sku;end if;
  v_units:=r.units;v_calc:=ceil(v_units*(1+p_reserve_pct/100));
  insert into public.sticker_order_items(sticker_order_id,shipment_item_id,sticker_template_version_id,product_id,units_to_label,reserve_pct,calculated_quantity,ordered_quantity,render_data_snapshot)
  values(v_id,r.id,v_version,r.product_id,v_units,p_reserve_pct,v_calc,ceil(v_calc::numeric/p_minimum_print_run)*p_minimum_print_run,jsonb_build_object('product_id',r.product_id,'sku',r.internal_sku,'name',r.name,'shipment_id',p_shipment_id,'customer_id',v_customer));
 end loop;
 if not exists(select 1 from public.sticker_order_items where sticker_order_id=v_id) then raise exception 'В поставке нет товаров, требующих стикеров';end if;return v_id;
end $$;

create or replace function public.change_sticker_order_status(p_order_id uuid,p_status text)
returns void language plpgsql security definer set search_path='' as $$ begin
 if not (select private.has_permission('stickers.order')) then raise exception 'Нет права изменять заказ стикеров';end if;
 if p_status not in ('ordered','received','cancelled') then raise exception 'Недопустимый статус';end if;
 update public.sticker_orders set status=p_status,ordered_at=case when p_status='ordered' then now() else ordered_at end,received_at=case when p_status='received' then now() else received_at end,updated_at=now() where id=p_order_id and ((status='calculated' and p_status in ('ordered','cancelled')) or (status='ordered' and p_status in ('received','cancelled')));if not found then raise exception 'Недопустимый переход статуса';end if;
 if p_status='received' then update public.sticker_order_items set received_quantity=ordered_quantity,updated_at=now() where sticker_order_id=p_order_id;end if;
end $$;

create or replace function public.record_sticker_application(p_item_id uuid,p_applied integer,p_spoiled integer,p_applied_by_name text)
returns void language plpgsql security definer set search_path='' as $$ declare v_order uuid;v_need numeric;begin
 if not (select private.has_permission('stickers.apply')) then raise exception 'Нет права учитывать нанесение стикеров';end if;
 if p_applied<0 or p_spoiled<0 or nullif(btrim(p_applied_by_name),'') is null then raise exception 'Укажите количество и работника склада';end if;
 select i.sticker_order_id,coalesce(si.received_quantity,si.confirmed_quantity,si.ordered_quantity) into v_order,v_need from public.sticker_order_items i join public.shipment_items si on si.id=i.shipment_item_id join public.sticker_orders o on o.id=i.sticker_order_id where i.id=p_item_id and o.status in ('received','applied') for update of i,o;if not found then raise exception 'Сначала отметьте получение стикеров';end if;
 update public.sticker_order_items set actual_units_to_label=v_need,applied_quantity=p_applied,spoiled_quantity=p_spoiled,applied_by_name=btrim(p_applied_by_name),updated_at=now() where id=p_item_id;
 update public.sticker_orders o set status=case when not exists(select 1 from public.sticker_order_items i where i.sticker_order_id=v_order and i.applied_quantity<coalesce(i.actual_units_to_label,i.units_to_label)) then 'applied' else 'received' end,updated_at=now() where id=v_order;
end $$;

create or replace function public.create_marking_code_order(p_partner_id uuid,p_shipment_id uuid,p_product_id uuid,p_quantity integer,p_code_type text)
returns uuid language plpgsql security definer set search_path='' as $$ declare v_id uuid;begin
 if not (select private.has_permission('marking.manage')) then raise exception 'Нет права заказывать коды маркировки';end if;
 if p_quantity<1 or p_code_type not in ('unit','box') then raise exception 'Некорректное количество или тип кода';end if;
 if not exists(select 1 from public.products where id=p_product_id and requires_marking) then raise exception 'Товар не требует маркировки';end if;
 insert into public.marking_code_orders(order_number,partner_id,shipment_id,product_id,quantity_requested,code_type) values(format('MK-%s-%s',extract(year from current_date)::int,lpad(nextval('public.marking_order_number_seq')::text,6,'0')),p_partner_id,p_shipment_id,p_product_id,p_quantity,p_code_type) returning id into v_id;return v_id;
end $$;

create or replace function public.update_marking_code_order(p_order_id uuid,p_status text,p_quantity_received integer,p_quantity_applied integer,p_codes_document_id uuid)
returns void language plpgsql security definer set search_path='' as $$begin
 if not (select private.has_permission('marking.manage')) then raise exception 'Нет права изменять маркировку';end if;
 if p_status not in ('requested','received','partially_applied','applied','cancelled') or p_quantity_received<0 or p_quantity_applied<0 or p_quantity_applied>p_quantity_received then raise exception 'Некорректные данные маркировки';end if;
 update public.marking_code_orders set status=p_status,quantity_received=p_quantity_received,quantity_applied=p_quantity_applied,codes_document_id=coalesce(p_codes_document_id,codes_document_id),requested_at=case when p_status='requested' then now() else requested_at end,received_at=case when p_status in ('received','partially_applied','applied') then coalesce(received_at,now()) else received_at end,updated_at=now() where id=p_order_id and status<>'cancelled';if not found then raise exception 'Заказ маркировки не найден';end if;
end $$;

do $$ declare f text;begin foreach f in array array['public.create_sticker_template(text,uuid,uuid,text,text[],jsonb,uuid)','public.add_sticker_template_version(uuid,jsonb,uuid)','public.submit_sticker_template_version(uuid)','public.decide_sticker_template_version(uuid,boolean,text)','public.create_sticker_order(uuid,uuid,numeric,integer)','public.change_sticker_order_status(uuid,text)','public.record_sticker_application(uuid,integer,integer,text)','public.create_marking_code_order(uuid,uuid,uuid,integer,text)','public.update_marking_code_order(uuid,text,integer,integer,uuid)'] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);end loop;end $$;
grant execute on function public.create_sticker_template(text,uuid,uuid,text,text[],jsonb,uuid),public.add_sticker_template_version(uuid,jsonb,uuid),public.submit_sticker_template_version(uuid),public.decide_sticker_template_version(uuid,boolean,text),public.create_sticker_order(uuid,uuid,numeric,integer),public.change_sticker_order_status(uuid,text),public.record_sticker_application(uuid,integer,integer,text),public.create_marking_code_order(uuid,uuid,uuid,integer,text),public.update_marking_code_order(uuid,text,integer,integer,uuid) to authenticated;

do $$ declare t text;begin foreach t in array array['sticker_templates','sticker_template_versions','sticker_orders','sticker_order_items','marking_code_orders'] loop execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);end loop;end $$;

comment on table public.sticker_template_versions is 'Immutable sticker layout versions; printing requires approved status';
comment on column public.sticker_order_items.render_data_snapshot is 'Frozen substitution data used for the print run';
comment on table public.marking_codes is 'Sensitive marking codes: never commit values to source control or application logs';
