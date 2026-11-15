import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const state = { calls: [], paths: [], error: null, authDenied: false };
globalThis.__historicalTest = state;
const id = 'af610000-0000-4000-8000-000000000001';
const modules = {
  'next/cache': 'export const revalidatePath = p => globalThis.__historicalTest.paths.push(p);',
  'next/navigation': 'export const redirect = p => { throw new Error("REDIRECT:"+p); };',
  '@/lib/auth/access': `export async function requireUser() {
    const s=globalThis.__historicalTest;
    if(s.authDenied) throw new Error('AUTH_DENIED');
    return {supabase:{rpc:async(name,args)=>{s.calls.push({name,args});return {data:'${id}',error:s.error};}}};
  }`,
};
registerHooks({ resolve(specifier, context, next) {
  if (Object.hasOwn(modules, specifier)) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  if (specifier === '@/lib/errors/public-message') return next(new URL('../../src/lib/errors/public-message.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
const { createHistoricalCustomerOrder, recordHistoricalSaleReceipt } = await import('../../src/app/sales/actions.ts');
const data = new FormData();
for (const key of ['request_id','customer_id','warehouse_id','currency_id']) data.set(key,id);
data.set('shipment_date','2026-10-20');data.set('reference',' INV-1 ');data.set('reason',' Историческая отгрузка ');
await assert.rejects(createHistoricalCustomerOrder(data), /REDIRECT:.*success=/);
assert.deepEqual(state.calls, [{ name: 'create_historical_customer_order', args: {
  p_request_id:id,p_customer_id:id,p_warehouse_id:id,p_currency_id:id,p_contract_id:null,
  p_shipment_date:'2026-10-20',p_reference:'INV-1',p_reason:'Историческая отгрузка',p_notes:null,
} }]);
assert.deepEqual(state.paths,['/sales']);
state.calls=[];state.paths=[];state.error={code:'42501',message:'DO_NOT_EXPOSE_SQL'};
await assert.rejects(createHistoricalCustomerOrder(data), e=>e.message.includes('error=')&&!e.message.includes('DO_NOT_EXPOSE_SQL'));
assert.equal(state.calls.length,1);assert.equal(state.paths.length,0);
state.calls=[];state.error=null;state.authDenied=true;
await assert.rejects(createHistoricalCustomerOrder(data),/AUTH_DENIED/);assert.equal(state.calls.length,0);
state.authDenied=false;
for(const [key,value] of [['reason',' '],['reason','x'.repeat(501)],['reference',''],['reference','x'.repeat(201)],['shipment_date','bad-date'],['request_id','bad-id']]){
  const old=data.get(key);data.set(key,value);
  await assert.rejects(createHistoricalCustomerOrder(data));assert.equal(state.calls.length,0);
  data.set(key,old);
}
console.log('historical sale action passed');
const receipt=new FormData();
receipt.set('sale_id',id);receipt.set('request_id',id);receipt.set('expected_token','a'.repeat(32));
receipt.set('reason',' Факт приёмки подтвердил владелец без письма и согласования ');receipt.set('acknowledged','on');
await assert.rejects(recordHistoricalSaleReceipt(receipt),/REDIRECT:.*success=/);
assert.deepEqual(state.calls,[{name:'record_historical_sale_receipt',args:{p_sale_id:id,p_request_id:id,p_expected_token:'a'.repeat(32),p_reason:'Факт приёмки подтвердил владелец без письма и согласования',p_acknowledged:true}}]);
state.calls=[];state.paths=[];
for(const [key,value] of [['acknowledged',''],['reason','коротко'],['reason','x'.repeat(2001)],['expected_token','bad'],['sale_id','bad'],['request_id','bad']]){
 const old=receipt.get(key);receipt.set(key,value);await assert.rejects(recordHistoricalSaleReceipt(receipt));assert.equal(state.calls.length,0);receipt.set(key,old);
}
state.authDenied=true;await assert.rejects(recordHistoricalSaleReceipt(receipt),/AUTH_DENIED/);assert.equal(state.calls.length,0);
state.authDenied=false;state.error={code:'42501',message:'SECRET_SQL'};
await assert.rejects(recordHistoricalSaleReceipt(receipt),e=>e.message.includes('error=')&&!e.message.includes('SECRET_SQL'));assert.equal(state.paths.length,0);
console.log('historical receipt action passed');

// The date-only correction must never call reservation/fulfillment or use a privileged client.
const {correctCustomerOrderDate} = await import('../../src/app/sales/actions.ts');
const correction=new FormData();
for(const [key,value] of Object.entries({sale_id:id,request_id:id,expected_date:'2026-11-09',planned_shipment_date:'2026-11-05',reason:' Исправление по документу INV-TEST '})) correction.set(key,value);
state.calls=[];state.paths=[];state.error=null;
await assert.rejects(correctCustomerOrderDate(correction),/REDIRECT:.*success=/);
assert.deepEqual(state.calls,[{name:'correct_customer_order_date',args:{p_sale_id:id,p_request_id:id,p_expected_date:'2026-11-09',p_date:'2026-11-05',p_reason:'Исправление по документу INV-TEST'}}]);
assert.deepEqual(state.paths,[`/sales/${id}`,'/sales']);
state.calls=[];state.paths=[];state.error={code:'42501',message:'PRIVATE_SQL'};
await assert.rejects(correctCustomerOrderDate(correction),e=>e.message.includes('error=')&&!e.message.includes('PRIVATE_SQL'));
assert.equal(state.calls.length,1);assert.equal(state.paths.length,0);
state.calls=[];state.authDenied=true;
await assert.rejects(correctCustomerOrderDate(correction),/AUTH_DENIED/);
assert.equal(state.calls.length,0);
console.log('administrative date action passed');
