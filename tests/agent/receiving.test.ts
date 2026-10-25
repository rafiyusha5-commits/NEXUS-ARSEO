import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseOperationIntent} from '../../src/lib/agent/operations.ts';
const row={item_id:'10000000-0000-4000-8000-000000000001',accepted_quantity:'92',damaged_quantity:'3',batch_number:'LOT-1',manufacture_date:null,expiry_date:'2027-10-01',discrepancy_reason:'5 недостача, 3 повреждены'};
const command={kind:'shipment_transport_receive',params:{transport_id:'10000000-0000-4000-8000-000000000002',location_id:null,lines:[row]}};
test('receiving preserves explicit quantities, dates and unknown optional facts',()=>assert.deepEqual(parseOperationIntent(command),command));
test('receiving rejects incomplete, repeated and oversized sets',()=>{
 for(const lines of [[],[row,row],Array.from({length:21},()=>row),[{...row,item_id:undefined}],[{...row,damaged_quantity:undefined}]])
  assert.equal(parseOperationIntent({...command,params:{...command.params,lines}}),null);
});
test('receiving never coerces unknown/negative/rounded/scientific quantities',()=>{
 for(const value of [null,undefined,92,'-1','NaN','1e3','0.0001',''])
  assert.equal(parseOperationIntent({...command,params:{...command.params,lines:[{...row,accepted_quantity:value}]}}),null);
});
test('receiving requires batch, expiry and damage explanation, rejects impossible dates',()=>{
 for(const delta of [{batch_number:null},{expiry_date:null},{expiry_date:'2027-02-30'},{discrepancy_reason:null},{manufacture_date:'2028-01-01'},{ignore:true}])
  assert.equal(parseOperationIntent({...command,params:{...command.params,lines:[{...row,...delta}]}}),null);
});
test('receiving cannot select performer, bypass rights or silently omit location choice',()=>{
 for(const delta of [{location_id:undefined},{confirmed:true},{performed_by_name:'boss'},{ignore:true}])
  assert.equal(parseOperationIntent({...command,params:{...command.params,...delta}}),null);
});
