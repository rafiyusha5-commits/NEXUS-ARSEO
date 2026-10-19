import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return next('next/dist/compiled/server-only/empty.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(resolve(root, 'src', specifier.slice(2) + '.ts')).href, context);
  return next(specifier, context);
} });
const { loadShipmentReport } = await import('../../src/lib/shipment-report.ts');

export async function checkPilotReport(snapshot) {
  let priceCalls = 0;
  const client = {
    from(table) {
      assert.ok(Object.hasOwn(snapshot, table), `Unexpected report table ${table}`);
      let rows = structuredClone(snapshot[table] ?? []);
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { rows = rows.filter(r => r[k] === v); return q; },
        in(k, vs) { rows = rows.filter(r => vs.includes(r[k])); return q; },
        is(k, v) { rows = rows.filter(r => (r[k] ?? null) === v); return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        then(yes, no) { return Promise.resolve({ data: rows, error: null }).then(yes, no); },
      };
      return q;
    },
    async rpc(name) {
      assert.equal(name, 'my_shipment_item_purchase_prices'); priceCalls++;
      return { data: snapshot.prices, error: null };
    },
  };
  const report = await loadShipmentReport(client, snapshot.shipments[0].id, new Set(['prices.purchase.view']));
  assert.equal(report.totals.ordered, 150);
  assert.equal(report.totals.accepted, 147);
  assert.equal(report.totals.batches, 147);
  assert.equal(report.totals.movements, 147);
  assert.equal(report.totals.reconciled, true);
  assert.equal(report.items.reduce((n, i) => n + i.discrepancy, 0), -3);
  assert.equal(report.transports.length, 2);
  assert.equal(report.documents.length, 2);
  assert.equal(report.receipts.length, 2);
  assert.ok(report.items.every(i => Number(i.unit_price) > 0));
  const cmr = snapshot.documents.find(d => d.id === 'ee200000-0000-4000-8000-000000000001').document_type_id;
  assert.ok(snapshot.document_requirements.some(r => r.document_type_id === cmr && r.applies_to === 'shipment_transport' && r.is_mandatory));
  assert.equal(snapshot.document_links.length, 2, 'CMR on vehicle 1 plus shipment invoice');
  assert.ok(report.missingDocuments.some(r => r.requirement.document_type_id === cmr && r.transport?.sequence_no === 2),
    'current report preserves missing CMR on vehicle 2');
  assert.equal(report.totals.confirmed, 150);
  assert.equal(report.totals.shipped, 150);
  assert.equal(report.shipment.status, 'closed');
  const hidden = await loadShipmentReport(client, snapshot.shipments[0].id, new Set());
  assert.ok(hidden.items.every(i => i.unit_price === null));
  assert.equal(priceCalls, 1, 'no purchase-price RPC without permission');
  console.log('PASS actual report loader: 150 ordered / 147 accepted, batches and receipts; price redaction');
  console.log('PASS missing CMR of vehicle 2 remains visible after closure');
}
