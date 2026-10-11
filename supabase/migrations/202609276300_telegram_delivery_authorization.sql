begin;
-- security_audit also found inherited default grants on these later tables.
-- RLS does not protect TRUNCATE; neither client-created triggers nor TRUNCATE
-- are part of the role model. Keep ordinary RLS-governed business operations.
revoke truncate,trigger on public.shipment_milestones,public.product_suppliers from authenticated;
-- These are employee-only business RPCs, not service-role integration endpoints.
revoke execute on function public.create_inventory_operation_document(text,date,uuid,uuid,text,text,text),
 public.add_inventory_operation_line(uuid,uuid,uuid,numeric,text,text),
 public.remove_inventory_operation_line(uuid), public.post_inventory_operation_document(uuid),
 public.cancel_inventory_operation_document(uuid,text) from service_role;
-- One STABLE snapshot for claim, chat binding, employee state and ALL permissions.
-- This is a boolean authorization decision only, not service-role business access.
create or replace function public.telegram_authorize_delivery(
 p_update_id bigint,p_token text,p_user_id uuid,p_requirements jsonb
) returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 if p_user_id is null or p_token is null or jsonb_typeof(p_requirements) is distinct from 'array'
    or jsonb_array_length(p_requirements)>64 then return false;end if;
 if exists(select 1 from jsonb_array_elements(p_requirements) g where
   jsonb_typeof(g) is distinct from 'object' or jsonb_typeof(g->'all') is distinct from 'array'
   or jsonb_typeof(g->'any') is distinct from 'array') then return false;end if;
 if exists(select 1 from jsonb_array_elements(p_requirements) g where
   jsonb_array_length(g->'all')>64 or jsonb_array_length(g->'any')>64
   or exists(select 1 from jsonb_array_elements((g->'all')||(g->'any')) c
     where jsonb_typeof(c) is distinct from 'string' or length(c#>>'{}')>100)) then return false;end if;
 return exists(
   select 1 from public.telegram_updates u join public.telegram_links l on l.chat_id=u.chat_id
   where u.update_id=p_update_id and u.claim_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')
    and u.status='delivery_started' and (u.user_id is null or u.user_id=p_user_id) and l.user_id=p_user_id
    and private.user_has_permission(p_user_id,'agent.use')
    and not exists(select 1 from jsonb_array_elements(p_requirements) g where
      exists(select 1 from jsonb_array_elements_text(g->'all') c where not private.user_has_permission(p_user_id,c))
      or (jsonb_array_length(g->'any')>0 and not exists(
        select 1 from jsonb_array_elements_text(g->'any') c where private.user_has_permission(p_user_id,c))))
 );
end$$;
revoke all on function public.telegram_authorize_delivery(bigint,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.telegram_authorize_delivery(bigint,text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
