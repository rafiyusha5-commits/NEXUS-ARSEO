import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeConfirmedSources, VEHICLE_SCOPED_FIELDS } from "../../src/lib/document-extraction/rules.ts";
import { ruleViolationMessage } from "../../src/lib/errors/public-message.ts";
import { buildShipmentGenerationData, TRANSPORT_GENERATION_FIELDS } from "../../src/lib/templates/generation.ts";
import { buildShipmentDocumentReadiness } from "../../src/lib/templates/readiness.ts";
import { selectGenerationScope } from "../../src/lib/templates/generation-scope.ts";
import { createTransportArguments, describeTransport, duplicatePlates, normalizePlate, readTransportForm, transportChanges } from "../../src/lib/shipments/transport-form.ts";

const form = (values: Record<string, string>) => readTransportForm(key => values[key] ?? "");

describe("vehicle form", () => {
  it("reads every field of a vehicle, trimming and collapsing spaces", () => {
    const result = form({ driver_name: "  Иванов   И.И. ", vehicle_plate: " 111 AAA 11 ", planned_loading_date: "2030-05-01" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.values.driver_name, "Иванов И.И.");
    assert.equal(result.values.vehicle_plate, "111 AAA 11");
    assert.equal(result.values.trailer_plate, "", "missing fields are empty strings");
  });

  it("refuses over-long fields, malformed dates and an arrival before loading, with a clear message", () => {
    assert.deepEqual(form({ vehicle_plate: "X".repeat(41) }), { ok: false, error: "Поле «Госномер автомобиля» длиннее 40 символов" });
    assert.deepEqual(form({ planned_loading_date: "01.05.2030" }), { ok: false, error: "Поле «План загрузки» должно быть датой" });
    assert.deepEqual(form({ planned_loading_date: "2030-05-10", planned_arrival_date: "2030-05-01" }), { ok: false, error: "Плановое прибытие раньше плановой загрузки" });
  });

  it("builds RPC arguments with null for empty fields and a patch that clears them", () => {
    const result = form({ driver_name: "Петров П.П.", vehicle_plate: "222CCC22", trailer_make: "KRONE" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const args = createTransportArguments("shipment-1", result.values);
    assert.equal(args.p_shipment_id, "shipment-1");
    assert.equal(args.p_driver_name, "Петров П.П.");
    assert.equal(args.p_driver_phone, null);
    assert.equal(args.p_trailer_make, "KRONE");
    const changes = transportChanges(result.values);
    assert.equal(changes.driver_phone, "", "an empty form field clears the stored value");
    assert.equal(changes.vehicle_plate, "222CCC22");
    assert.equal(Object.keys(changes).length, 12, "every vehicle field is part of an edit");
  });

  it("describes vehicles and finds duplicate plates the way the database does", () => {
    assert.equal(describeTransport({ sequence_no: 2, vehicle_plate: "222CCC22", driver_name: "Петров П.П." }), "№2 · 222CCC22 · Петров П.П.");
    assert.equal(describeTransport({ sequence_no: 3 }), "№3");
    assert.equal(normalizePlate("111 aaa-11"), "111AAA11");
    const list = [{ sequence_no: 1, vehicle_plate: "111 AAA 11" }, { sequence_no: 2, vehicle_plate: "111-aaa-11" }, { sequence_no: 3, vehicle_plate: "111-aaa-11", status: "cancelled" }, { sequence_no: 4, vehicle_plate: "" }];
    assert.deepEqual(duplicatePlates(list), ["111AAA11"]);
    assert.deepEqual(duplicatePlates([{ sequence_no: 1, vehicle_plate: "A" }, { sequence_no: 2, vehicle_plate: "A", status: "cancelled" }]), [], "a cancelled vehicle does not count");
  });
});

describe("source documents belong to a vehicle", () => {
  const first = "t-1", second = "t-2";
  const sources = [
    { data: { contract_number: "C-1", incoterms: "DAP" }, transportId: null },
    { data: { driver_name: "Driver One", vehicle_plate: "111AAA11", seals: "S1" }, transportId: first },
    { data: { driver_name: "Driver Two", vehicle_plate: "222CCC22", trailer_plate: "T2", seals: "S2" }, transportId: second },
  ];

  it("gives each vehicle only the facts of its own documents, and every vehicle the shipment-level facts", () => {
    const one = mergeConfirmedSources({}, sources, { transportId: first, transportCount: 2 });
    assert.equal(one.driver_name, "Driver One");
    assert.equal(one.vehicle_plate, "111AAA11");
    assert.equal(one.seals, "S1");
    assert.equal(one.trailer_plate, undefined, "no trailer data of the other vehicle leaks in");
    assert.equal(one.contract_number, "C-1");
    const two = mergeConfirmedSources({}, sources, { transportId: second, transportCount: 2 });
    assert.equal(two.driver_name, "Driver Two");
    assert.equal(two.trailer_plate, "T2");
    assert.equal(two.incoterms, "DAP");
    assert.equal(two.unassigned_vehicle_fields, undefined);
  });

  it("never puts an unbound document on a vehicle when there are several, and says so", () => {
    const merged = mergeConfirmedSources({}, [...sources, { data: { driver_name: "Nobody knows", cmr_number: "99", contract_number: "C-2" }, transportId: null }], { transportId: first, transportCount: 2 });
    assert.equal(merged.driver_name, "Driver One");
    assert.equal(merged.cmr_number, undefined);
    assert.equal(merged.contract_number, "C-2", "shipment-level facts still apply");
    assert.deepEqual(new Set(merged.unassigned_vehicle_fields as string[]), new Set(["driver_name", "cmr_number"]));
  });

  it("keeps the earlier behaviour for a shipment with a single vehicle", () => {
    const merged = mergeConfirmedSources({}, [{ data: { driver_name: "Only Driver", vehicle_plate: "SOLO", contract_number: "C-9" }, transportId: null }], { transportId: first, transportCount: 1 });
    assert.equal(merged.driver_name, "Only Driver");
    assert.equal(merged.vehicle_plate, "SOLO");
    assert.equal(merged.unassigned_vehicle_fields, undefined);
    const noVehicles = mergeConfirmedSources({}, [{ data: { driver_name: "X" }, transportId: null }], { transportId: null, transportCount: 0 });
    assert.equal(noVehicles.driver_name, "X");
  });

  it("applies each vehicle's data to the generated transport row", () => {
    const merged = mergeConfirmedSources({ transports: [{ sequence_no: 2, vehicle_plate: "from-card" }] }, sources, { transportId: second, transportCount: 2 });
    const transport = (merged.transports as Array<Record<string, unknown>>)[0];
    assert.equal(transport.driver_name, "Driver Two");
    assert.equal(transport.vehicle_plate, "222CCC22", "a confirmed document wins over the card value");
    assert.equal(transport.trailer_plate, "T2");
  });

  it("lists exactly the fields that describe a vehicle", () => {
    for (const field of ["driver_name", "driver_phone", "driver_document", "vehicle_plate", "vehicle_make", "trailer_plate", "trailer_make", "carrier_name"]) assert.ok(VEHICLE_SCOPED_FIELDS.includes(field as never), field);
    for (const field of ["contract_number", "incoterms", "invoice_number", "esf_number", "order_number"]) assert.equal(VEHICLE_SCOPED_FIELDS.includes(field as never), false, field);
  });
});

describe("generation for a vehicle", () => {
  const raw = (transports: Array<Record<string, unknown>>) => buildShipmentGenerationData({
    shipment: { shipment_number: "S-1", type: "export" }, items: [], products: new Map(), identifiers: [], packaging: [], includePrices: false, transports,
  });

  it("reads the vehicle's own columns and falls back to the linked master-data vehicle", () => {
    const data = raw([
      { sequence_no: 1, vehicle_plate: "111AAA11", vehicle_make: "SCANIA", trailer_plate: "22BBB22", trailer_make: "SCHMITZ", driver_name: "Иванов", driver_document: "уд. 1", carrier_name: "ТОО А" },
      { sequence_no: 2, vehicle: { plate_number: "MASTER-2", trailer_plate_number: "MT-2" }, carrier: { counterparty: { legal_name: "Master Carrier" } } },
    ]);
    const [one, two] = data.transports;
    assert.deepEqual([one.vehicle_plate, one.vehicle_make, one.trailer_plate, one.trailer_make, one.driver_document, one.carrier_name], ["111AAA11", "SCANIA", "22BBB22", "SCHMITZ", "уд. 1", "ТОО А"]);
    assert.deepEqual([two.vehicle_plate, two.trailer_plate, two.carrier_name, two.vehicle_make], ["MASTER-2", "MT-2", "Master Carrier", ""]);
  });

  it("offers the new vehicle fields to DOCX templates", () => {
    const keys = TRANSPORT_GENERATION_FIELDS.map(field => field.key);
    for (const key of ["vehicle_make", "trailer_make", "driver_document", "driver_name", "vehicle_plate", "trailer_plate", "carrier_name"]) assert.ok(keys.includes(key), key);
  });

  it("forces a choice of vehicle for several vehicles and only takes the cargo bound to it", () => {
    const items = [{ id: "a", shipment_transport_id: "t1" }, { id: "b", shipment_transport_id: "t2" }, { id: "c", shipment_transport_id: null }];
    const transports = [{ id: "t1", sequence_no: 1 }, { id: "t2", sequence_no: 2 }];
    assert.throws(() => selectGenerationScope(items, transports), /Выберите автомобиль/);
    assert.deepEqual(selectGenerationScope(items, transports, "t2").selectedItems.map(item => item.id), ["b"], "unallocated cargo is not assigned automatically");
    assert.throws(() => selectGenerationScope([{ id: "c", shipment_transport_id: null }], transports, "t1"), /не распределены/);
    assert.equal(selectGenerationScope(items, [transports[0]]).selectedItems.length, 3, "a single vehicle takes the whole shipment");
  });

  it("warns about documents without a vehicle and about cargo that is not allocated", () => {
    const warnings = (data: Record<string, unknown>) => buildShipmentDocumentReadiness({ shipment_number: "S", ...data }).items.filter(item => ["vehicle_documents_bound", "cargo_allocated"].includes(item.key) && !item.ready).map(item => item.key);
    assert.deepEqual(warnings({}), []);
    assert.deepEqual(warnings({ unassigned_vehicle_fields: ["driver_name"], unallocated_item_count: 2 }).sort(), ["cargo_allocated", "vehicle_documents_bound"]);
    assert.equal(buildShipmentDocumentReadiness({ shipment_number: "S", unallocated_item_count: 2 }).ready === buildShipmentDocumentReadiness({ shipment_number: "S" }).ready, true, "they warn, they do not block");
  });
});

describe("messages of database rules", () => {
  it("shows the authored Russian message of a rule violation, and nothing else", () => {
    assert.equal(ruleViolationMessage({ code: "P0001", message: "Автомобиль с госномером 111AAA11 уже есть в этой поставке" }), "Автомобиль с госномером 111AAA11 уже есть в этой поставке");
    assert.equal(ruleViolationMessage({ code: "P0001", message: "internal: relation secret does not exist" }, "fallback"), "fallback");
    assert.equal(ruleViolationMessage({ code: "XX000", message: "Ошибка с утечкой деталей" }, "fallback"), "fallback");
    assert.equal(ruleViolationMessage({ code: "42501", message: "permission denied" }), "Недостаточно прав для этого действия.");
    assert.equal(ruleViolationMessage({ code: "P0001", message: "Я".repeat(400) }, "fallback"), "fallback");
  });
});
