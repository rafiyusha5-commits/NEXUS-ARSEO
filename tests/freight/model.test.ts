import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {directoryValues,tripValues,fields,fieldValue} from '../../src/lib/freight/model.ts';
describe('freight form payloads',()=>{
 it('does not reactivate an inactive carrier when reopening its form',()=>{
  assert.equal(fieldValue('carrier',{directory_active:false},'active'),false);
  assert.equal(fieldValue('driver',{active:false},'active'),false);
  assert.equal(fieldValue('carrier',null,'active'),undefined);
 });
 it('keeps same phone on different drivers and does not accept an identity document in ordinary driver form',()=>{
  const form=new FormData();form.set('full_name','Иванов');form.set('phones','+7 000\n +7 111');form.set('active','on');form.set('iin','secret');
  assert.deepEqual(directoryValues('driver',form),{full_name:'Иванов',phones:['+7 000','+7 111'],whatsapp:null,carrier_id:null,active:true,inactive_reason:null});
  assert.ok(!fields('driver',[],[]).some(f=>f.key==='iin'));
 });
 it('keeps unknown capacities null, not zero, and country separate from the number',()=>{
  const form=new FormData();form.set('plate_number','ABC 123');form.set('registration_country','PL');const values=directoryValues('vehicle',form);
  assert.equal(values.capacity_kg,null);assert.equal(values.pallet_capacity,null);assert.equal(values.registration_country,'PL');assert.equal(values.plate_number,'ABC 123');
 });
 it('requires explicit manual address confirmation and preserves per-trip pallet tare',()=>{
  const form=new FormData();form.set('pallet_tare_kg','25');form.set('origin_address','Алматы');form.set('destination_warehouse','warehouse');
  const first=tripValues(form);assert.deepEqual(first.origin,{warehouse_id:null,address:'Алматы',contact:null,confirmed:false});
  form.set('origin_confirmed','on');assert.equal((tripValues(form).origin as {confirmed:boolean}).confirmed,true);assert.equal(first.pallet_tare_kg,'25');
 });
});
