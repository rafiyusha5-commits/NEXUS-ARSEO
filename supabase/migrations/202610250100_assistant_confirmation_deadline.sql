-- Upgrade already-applied assistant handlers without changing identity, ACLs or receipts.
begin;
do $migration$
declare entry record; definition text; needle text; guard text;
begin
 for entry in select * from (values
  ('private.confirm_assistant_transfer(uuid,uuid)','row',' doc:=public.create_inventory_operation_document'),
  ('private.confirm_assistant_stock_operation(uuid,uuid)','r',' perform public.fulfill_customer_order(sale);'),
  ('private.confirm_assistant_prior_operation(uuid,uuid)','r',' sale:=public.create_customer_order'),
  ('private.confirm_assistant_before_confirmation(uuid,uuid)','r',' for line in select id from public.sale_items where sale_id=sale order by id loop'),
  ('private.confirm_assistant_before_receiving(uuid,uuid)','r',' begin perform public.confirm_customer_order(sale);')
 ) as targets(signature,row_name,anchor) loop
  if to_regprocedure(entry.signature) is null then raise exception 'Missing assistant handler: %',entry.signature;end if;
  definition:=pg_get_functiondef(to_regprocedure(entry.signature));
  guard:=format(' if %s.expires_at<clock_timestamp() then raise exception ''ASSISTANT_OPERATION_EXPIRED'';end if;',entry.row_name);
  needle:=entry.anchor;
  if position(guard||E'\n'||needle in definition)>0 then continue;end if;
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
   raise exception 'Unexpected assistant handler definition: %',entry.signature;
  end if;
  execute replace(definition,needle,guard||E'\n'||needle);
 end loop;
end $migration$;
commit;
