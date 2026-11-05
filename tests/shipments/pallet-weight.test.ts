import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShipmentLoadSummary } from "../../src/lib/shipments/load-summary.ts";
import { fullCargoGross, validPalletWeight } from "../../src/lib/shipments/pallet-weight.ts";

const quantities = [15552, 42768, 36720];
const factors = [24, 22, 30];
const boxes = [2.709, 2.505, 3.329];
const items = quantities.map((q,i) => ({ id:String(i),product_id:String(i),uom:"piece",ordered_quantity:q,shipment_transport_id:"t" }));
const packs = quantities.flatMap((_,i) => [
  {product_id:String(i),uom:"piece",units_per_parent:1,gross_weight_kg:.102,net_weight_kg:.1},
  {product_id:String(i),uom:"box",units_per_parent:factors[i],gross_weight_kg:boxes[i]},
  {product_id:String(i),uom:"pallet",units_per_parent:factors[i]*72,gross_weight_kg:999},
]);
test("cartons and empty pallets counted once, purchase 22 and sale 25 isolated", () => {
  const transports = [{id:"t",purchase_pallet_tare_kg:22,sale_pallet_tare_kg:25}];
  const purchase = buildShipmentLoadSummary(items,packs,{transports,operation:"purchase"});
  const sale = buildShipmentLoadSummary(items,packs,{transports,operation:"sale"});
  assert.equal(purchase.pallets,53);
  assert.equal(purchase.boxedGrossWeightKg?.toFixed(3),"10699.848");
  assert.equal(purchase.grossWithPalletsKg?.toFixed(2),"11865.85");
  assert.equal(sale.grossWithPalletsKg?.toFixed(2),"12024.85");
  assert.equal(purchase.grossWeightKg?.toFixed(2),"9694.08");
  assert.deepEqual(transports,[{id:"t",purchase_pallet_tare_kg:22,sale_pallet_tare_kg:25}]);
});
test("weights of another vehicle or operation never substitute for missing data", () => {
  assert.equal(buildShipmentLoadSummary(items,packs,{operation:"sale",transports:[{id:"t",purchase_pallet_tare_kg:22}]}).grossWithPalletsKg,null);
  assert.equal(buildShipmentLoadSummary(items,packs,{operation:"purchase",transports:[{id:"other",purchase_pallet_tare_kg:22}]}).grossWithPalletsKg,null);
});
test("a partial total or fractional pallet is not presented as full cargo gross", () => {
  const context = {operation:"purchase" as const,transports:[{id:"t",purchase_pallet_tare_kg:22}]};
  assert.equal(buildShipmentLoadSummary(items,packs.filter(p=>!(p.product_id==="1"&&p.uom==="box")),context).grossWithPalletsKg,null);
  assert.equal(fullCargoGross(100,1.5,22),null);
  assert.equal(fullCargoGross(null,2,22),null);
});
test("20–25 kg inclusive and two decimal places, no false zero or non-finite input", () => {
  for(const n of [20,22,22.5,25]) assert.equal(validPalletWeight(n),n);
  for(const n of [null,undefined,"",0,19.99,25.01,22.555,NaN,Infinity,"NaN"]) assert.equal(validPalletWeight(n),null);
});
