import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const state = { calls: [], paths: [], error: null, authDenied: false };
globalThis.__fulfillmentTest = state;
const modules = {
  'next/cache': 'export const revalidatePath = p => globalThis.__fulfillmentTest.paths.push(p);',
  'next/navigation': 'export const redirect = p => { throw new Error("REDIRECT:"+p); };',
  '@/lib/auth/access': `export async function requireUser() {
    const s=globalThis.__fulfillmentTest;
    if(s.authDenied) throw new Error('AUTH_DENIED');
    return {supabase:{rpc:async(name,args)=>{s.calls.push({name,args});return {error:s.error};}}};
  }`,
};
registerHooks({ resolve(specifier, context, next) {
  if (Object.hasOwn(modules, specifier)) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  if (specifier === '@/lib/errors/public-message') return next(new URL('../../src/lib/errors/public-message.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
const { fulfillCustomerOrder, returnCustomerOrderToPreparation } = await import('../../src/app/sales/actions.ts');
const id = 'ef600000-0000-4000-8000-000000000001';
const data = new FormData(); data.set('sale_id', id);
await assert.rejects(fulfillCustomerOrder(data), /REDIRECT:.*success=/);
assert.deepEqual(state.calls, [{ name: 'fulfill_customer_order', args: { p_sale_id: id } }]);
assert.deepEqual(state.paths, [`/sales/${id}`, '/sales', '/inventory', '/inventory/movements']);
state.calls = []; state.paths = []; state.error = { code: '42501', message: 'DO_NOT_EXPOSE_SQL' };
await assert.rejects(fulfillCustomerOrder(data), e => e.message.includes('error=') && !e.message.includes('DO_NOT_EXPOSE_SQL'));
assert.equal(state.calls.length, 1); assert.equal(state.paths.length, 0);
state.calls = []; state.authDenied = true;
await assert.rejects(fulfillCustomerOrder(data), /AUTH_DENIED/); assert.equal(state.calls.length, 0);
state.authDenied = false; data.set('sale_id', 'not-a-uuid');
await assert.rejects(fulfillCustomerOrder(data), /Некорректное поле/); assert.equal(state.calls.length, 0);
state.calls = []; state.paths = []; state.error = null;
data.set('sale_id', id); data.set('reason', 'Партия заблокирована');
await assert.rejects(returnCustomerOrderToPreparation(data), /REDIRECT:.*success=/);
assert.deepEqual(state.calls, [{ name: 'return_customer_order_to_preparation', args: { p_sale_id: id, p_reason: 'Партия заблокирована' } }]);
state.calls = []; state.authDenied = true;
await assert.rejects(returnCustomerOrderToPreparation(data), /AUTH_DENIED/);
assert.equal(state.calls.length, 0);
console.log('fulfillment action passed');
