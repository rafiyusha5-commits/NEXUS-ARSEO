// Test-only PostgREST-shaped reader. Unknown tables/RPCs fail closed.
// Data come from the real disposable SQL pilot, not another business-rule engine.
export function snapshotClient(snapshot: Record<string, unknown>, prices: boolean) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      if (!Object.hasOwn(snapshot, table)) throw new Error(`Missing SQL snapshot: ${table}`);
      let rows = structuredClone((snapshot[table] ?? []) as Record<string, unknown>[]);
      const q = {
        select() { return q; },
        order() { return q; },
        eq(k: string, v: unknown) { rows = rows.filter(r => r[k] === v); return q; },
        in(k: string, vs: unknown[]) { rows = rows.filter(r => vs.includes(r[k])); return q; },
        is(k: string, v: unknown) { rows = rows.filter(r => (r[k] ?? null) === v); return q; },
        limit(n: number) { rows = rows.slice(0, n); return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        then(yes: (value: unknown) => unknown, no?: (reason: unknown) => unknown) { return Promise.resolve({ data: rows, error: null }).then(yes, no); },
      };
      return q;
    },
    async rpc(name: string) {
      calls.push(name);
      if (name === "my_shipment_item_purchase_prices") {
        if (!prices) throw new Error("Price RPC without permission");
        return { data: snapshot.prices, error: null };
      }
      if (name === "shipment_document_check") return { data: snapshot.document_check, error: null };
      // Fixed-date shelf-life tests remain in the SQL pilot. Do not invent risks here.
      if (name === "shelf_life_risks") return { data: null, error: { message: "Not captured" } };
      throw new Error(`Unexpected snapshot RPC: ${name}`);
    },
  };
  return { client, calls };
}
