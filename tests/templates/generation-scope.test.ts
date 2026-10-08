import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectGenerationScope } from "../../src/lib/templates/generation-scope.ts";

describe("export package scope for several vehicles", () => {
  const transports = [{ id: "car-1", sequence_no: 1 }, { id: "car-2", sequence_no: 2 }];
  const items = [
    { id: "line-1", shipment_transport_id: "car-1" },
    { id: "line-2", shipment_transport_id: "car-2" },
    { id: "line-3", shipment_transport_id: "car-2" },
  ];

  it("requires an explicit vehicle when a shipment has several", () => {
    assert.throws(() => selectGenerationScope(items, transports), /Выберите автомобиль/);
  });

  it("keeps only the items allocated to the selected vehicle", () => {
    const result = selectGenerationScope(items, transports, "car-2");
    assert.equal(result.selectedTransport?.sequence_no, 2);
    assert.deepEqual(result.selectedItems.map(item => item.id), ["line-2", "line-3"]);
  });

  it("rejects a foreign vehicle and a vehicle without allocated goods", () => {
    assert.throws(() => selectGenerationScope(items, transports, "other"), /не относится к поставке/);
    assert.throws(() => selectGenerationScope([], transports, "car-1"), /не закреплён груз/);
  });
});
