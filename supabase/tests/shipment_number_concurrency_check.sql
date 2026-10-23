\set ON_ERROR_STOP 1
do $$ declare f record; begin
 select * into f from tests.shipment_number_inputs;
 assert (select count(*) from public.shipments where project_code='NUMBER-PARALLEL')=30,'all 30 simultaneous creations succeeded';
 assert (select count(distinct shipment_number) from public.shipments where project_code='NUMBER-PARALLEL')=30,'every shipment has a distinct number';
 assert not exists (
  select f.prefix||(f.base+n)::text from generate_series(1,30) v(n)
  except select shipment_number from public.shipments where project_code='NUMBER-PARALLEL'
 ),'the 30 numbers follow the previous maximum without gaps or truncation';
 assert not exists (
  select 1 from public.shipments s where s.project_code='NUMBER-PARALLEL'
  and (select count(*) from public.shipment_stage_runs r where r.shipment_id=s.id)<>
      (select count(*) from public.shipment_stages st where st.process_template_id=s.process_template_id and st.is_active)
 ),'every simultaneous creation includes the complete process';
end $$;
