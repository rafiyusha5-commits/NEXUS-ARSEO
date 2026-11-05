import assert from "node:assert/strict";
import { describe, it } from "node:test";
import PizZip from "pizzip";
import { assembleGenerationData } from "../../src/lib/templates/generation-assembly.ts";
import { cargoBlocker, findNumberConflicts, issuedSets, unallocatedCargo, vehicleSetStates, type IssuedRow } from "../../src/lib/templates/vehicle-sets.ts";
import { buildExportDocuments, buildExportModel, PreflightError, preflightExport } from "../../src/lib/export-workbook/index.ts";
import { separateVehicle } from "../../src/lib/export-workbook/vehicle-parts.ts";
import { XlsxWorkbook } from "../../src/lib/export-workbook/xlsx-package.ts";
import { fixtureBytes } from "../export-workbook/helpers.ts";

// ---- a shipment of two vehicles; every value that belongs to one vehicle carries that vehicle's tag ----------------

type Row = Record<string, unknown>;

const product = (id: string, tag: string): Row => ({ id, internal_sku: `SKU-${tag}`, name: { ru: `Товар ${tag}` }, hs_code: "0000000001", country_of_origin: "KZ" });
const packaging = (id: string): Row[] => [
  { product_id: id, uom: "piece", units_per_parent: 1, net_weight_kg: 0.2, gross_weight_kg: 0.25 },
  { product_id: id, uom: "box", units_per_parent: 10, net_weight_kg: 2, gross_weight_kg: 2.6 },
  { product_id: id, uom: "pallet", units_per_parent: 250, net_weight_kg: 100, gross_weight_kg: 140 },
];
const item = (id: string, productId: string, vehicle: string | null, quantity: number): Row => ({ id, product_id: productId, shipment_transport_id: vehicle, uom: "piece", ordered_quantity: quantity });

const transport = (id: string, sequence: number, tag: string): Row => ({
  id, sequence_no: sequence, status: "planned", sale_pallet_tare_kg: 25,
  vehicle_plate: `PLATE-${tag}`, vehicle_make: `MAKE-${tag}`, trailer_plate: `TRL-${tag}`, trailer_make: `TRLMAKE-${tag}`,
  driver_name: `Driver ${tag}`, driver_phone: `+7-${tag}-PHONE`, driver_document: `DOC-${tag}`, carrier_name: `Carrier ${tag}`, temperature_setpoint: `TEMP-${tag}`,
});

const shipment: Row = {
  id: "s1", shipment_number: "SHP-ISO-1", project_code: "PRJ", type: "export", status: "planning", incoterms: "DAP",
  supplier: { legal_name: "ТОО Тест-Продавец", short_name: "Тест-Продавец", tax_id: "000000000001", country: "KZ" },
  customer: { legal_name: "ООО Тест-Покупатель", short_name: "Тест-Покупатель", tax_id: "0000000002", country: "RU" },
  contract: { number: "CONTRACT-77" },
};

const products = [product("pa1", "A1"), product("pa2", "A2"), product("pb1", "B1"), product("pb2", "B2")];
const allPackaging = ["pa1", "pa2", "pb1", "pb2"].flatMap(packaging);
const identifiers: Row[] = [
  ...["A1", "A2", "B1", "B2"].flatMap((tag, index) => [
    { product_id: `p${tag.toLowerCase()}`, identifier_type: "box_barcode", value: `BARCODE-${tag}` },
    { product_id: `p${tag.toLowerCase()}`, identifier_type: "supplier_sku", value: `SUP-${tag}` },
    { product_id: `p${tag.toLowerCase()}`, identifier_type: "gtin", value: `GTIN-${index}` },
  ]),
];

const allItems = [
  item("i-a1", "pa1", "tA", 1000), item("i-a2", "pa2", "tA", 500),
  item("i-b1", "pb1", "tB", 2000), item("i-b2", "pb2", "tB", 750),
];
const vehicles = [transport("tA", 1, "A"), transport("tB", 2, "B")];

const sources = [
  { confirmed_data: { contract_number: "CONTRACT-77", incoterms: "DAP", loading_address: "Склад-1", unloading_address: "Склад-2", loading_city: "Город-Отправки" }, shipment_transport_id: null },
  { confirmed_data: { driver_name: "Driver A", vehicle_plate: "PLATE-A", seals: "SEAL-A", cmr_number: "CMR-DOC-A", shipping_date: "2030-01-15" }, shipment_transport_id: "tA" },
  { confirmed_data: { driver_name: "Driver B", vehicle_plate: "PLATE-B", seals: "SEAL-B", shipping_date: "2030-01-16" }, shipment_transport_id: "tB" },
  // a document nobody bound to a vehicle: with several vehicles it must reach none of them
  { confirmed_data: { driver_name: "UNBOUND-DRIVER", vehicle_plate: "UNBOUND-PLATE", seals: "UNBOUND-SEAL" }, shipment_transport_id: null },
];

const invoiceLines = [
  { product_name: "ТОВАР A1", hs_code: "0000000001", quantity: 1000, unit_price: 11, line_total: 11000 },
  { product_name: "ТОВАР A2", hs_code: "0000000001", quantity: 500, unit_price: 12, line_total: 6000 },
  { product_name: "ТОВАР B1", hs_code: "0000000001", quantity: 2000, unit_price: 21, line_total: 42000 },
  { product_name: "ТОВАР B2", hs_code: "0000000001", quantity: 750, unit_price: 22, line_total: 16500 },
  { product_name: "ТОВАР C-ТОЛЬКО-ИНВОЙС", hs_code: "0000000001", quantity: 3, unit_price: 1, line_total: 3 },
];

const assemble = (transportId: string | undefined, overrides: Partial<Parameters<typeof assembleGenerationData>[0]> = {}) => {
  const { data } = assembleGenerationData({
    shipment, items: allItems, transports: vehicles, transportId, products, identifiers, packaging: allPackaging,
    priceByItem: new Map(), includePrices: true,
    sources: [...sources.map(row => ({ ...row })), { confirmed_data: {}, extracted_data: { invoice_items: invoiceLines }, shipment_transport_id: null }],
    ...overrides,
  });
  return data;
};

const NUMBERS: Record<string, { cmr_number: string; ttn_number: string; packing_list_number: string }> = {
  tA: { cmr_number: "CMR-1001", ttn_number: "TTN-1001", packing_list_number: "PL-1001" },
  tB: { cmr_number: "CMR-2002", ttn_number: "TTN-2002", packing_list_number: "PL-2002" },
};

const issue = (transportId: string) => buildExportDocuments(fixtureBytes(), { ...assemble(transportId), ...NUMBERS[transportId] }, ["workbook", "cmr", "ttn", "packing_list"], { includePrices: true });

/** Every text a generated file carries: all worksheet strings and formulas, plus the package metadata. */
const contentOf = (bytes: Uint8Array) => {
  const zip = new PizZip(bytes);
  return zip.file(/\.xml$/).map(part => part.asText()).join("\n");
};

const TAGS_A = ["PLATE-A", "MAKE-A", "TRL-A", "TRLMAKE-A", "Driver A", "-A-PHONE", "DOC-A", "Carrier A", "TEMP-A", "SEAL-A", "CMR-1001", "TTN-1001", "PL-1001", "Товар A1", "Товар A2", "BARCODE-A1", "BARCODE-A2", "SKU-A", "SUP-A"];
const TAGS_B = ["PLATE-B", "MAKE-B", "TRL-B", "TRLMAKE-B", "Driver B", "-B-PHONE", "DOC-B", "Carrier B", "TEMP-B", "SEAL-B", "CMR-2002", "TTN-2002", "PL-2002", "Товар B1", "Товар B2", "BARCODE-B1", "BARCODE-B2", "SKU-B", "SUP-B"];
const UNBOUND = ["UNBOUND-DRIVER", "UNBOUND-PLATE", "UNBOUND-SEAL", "CMR-DOC-A", "C-ТОЛЬКО-ИНВОЙС"];

describe("one document set per vehicle: nothing of another vehicle gets in", () => {
  const forA = issue("tA");
  const forB = issue("tB");

  for (const [name, other, set] of [["vehicle A", TAGS_B, forA], ["vehicle B", TAGS_A, forB]] as const) {
    for (const output of ["workbook", "cmr", "ttn", "packing_list"] as const) {
      it(`${name}, ${output}: contains no data of the other vehicle and no unbound document data`, () => {
        const text = contentOf(set.find(document => document.output === output)!.bytes);
        for (const token of [...other, ...UNBOUND]) assert.equal(text.includes(token), false, `${token} must not appear in the ${output} of ${name}`);
      });
    }
  }

  it("the workbook of each vehicle carries its own vehicle, driver, trailer, carrier and numbers", () => {
    for (const [set, tag] of [[forA, "A"], [forB, "B"]] as const) {
      const book = XlsxWorkbook.load(set.find(document => document.output === "workbook")!.bytes);
      const input = book.sheet("данные");
      assert.equal(input.raw("C5"), `Driver ${tag}`);
      assert.equal(input.raw("C7"), `PLATE-${tag}`);
      assert.equal(input.raw("C8"), `MAKE-${tag}`);
      assert.equal(input.raw("C9"), `TRL-${tag}`);
      assert.equal(input.raw("C10"), `TRLMAKE-${tag}`);
      assert.equal(input.raw("C11"), `Carrier ${tag}`);
      assert.equal(input.raw("C18"), `SEAL-${tag}`);
    }
  });

  it("the three documents of a set are the sheets of one filled workbook for that vehicle", () => {
    for (const [set, tag, numbers] of [[forA, "A", NUMBERS.tA], [forB, "B", NUMBERS.tB]] as const) {
      const cmr = XlsxWorkbook.load(set.find(document => document.output === "cmr")!.bytes);
      const ttn = XlsxWorkbook.load(set.find(document => document.output === "ttn")!.bytes);
      const packing = XlsxWorkbook.load(set.find(document => document.output === "packing_list")!.bytes);
      assert.deepEqual([cmr.sheetNames(), ttn.sheetNames(), packing.sheetNames()], [["CMR"], ["ТТН"], ["упаков.лист"]]);
      assert.equal(cmr.sheet("CMR").raw("N1"), numbers.cmr_number, "the CMR number typed for this vehicle");
      assert.match(String(ttn.sheet("ТТН").raw("N2")), new RegExp(numbers.ttn_number));
      assert.equal(packing.sheet("упаков.лист").raw("K1"), numbers.packing_list_number);
      assert.match(String(cmr.sheet("CMR").raw("A51")), new RegExp(`PLATE-${tag}`));
    }
  });

  it("only the goods and quantities bound to the vehicle are in its documents", () => {
    const rows = (set: typeof forA) => {
      const sheet = XlsxWorkbook.load(set.find(document => document.output === "packing_list")!.bytes).sheet("упаков.лист");
      const result: Array<{ name: unknown; pieces: unknown }> = [];
      for (let row = 12; row < 40; row++) { const name = sheet.raw(`D${row}`); if (name) result.push({ name, pieces: sheet.raw(`E${row}`) }); }
      return { rows: result, sheet };
    };
    const a = rows(forA), b = rows(forB);
    assert.deepEqual(a.rows, [{ name: "Товар A1", pieces: 1000 }, { name: "Товар A2", pieces: 500 }]);
    assert.deepEqual(b.rows, [{ name: "Товар B1", pieces: 2000 }, { name: "Товар B2", pieces: 750 }]);
    // totals of the sheet are the vehicle's own cargo: 1500 and 2750 pieces
    const totalRow = (sheet: ReturnType<typeof rows>["sheet"], first: number) => sheet.raw(`E${first}`);
    assert.equal(totalRow(a.sheet, 14), 1500);
    assert.equal(totalRow(b.sheet, 14), 2750);
  });

  it("the invoice sets prices of the vehicle's own goods and never adds goods", () => {
    const lines = (set: typeof forA) => XlsxWorkbook.load(set.find(document => document.output === "workbook")!.bytes).sheet("для Диляры");
    const a = lines(forA), b = lines(forB);
    assert.deepEqual([a.raw("F17"), a.raw("F18")], [11, 12]);
    assert.deepEqual([b.raw("F17"), b.raw("F18")], [21, 22]);
    assert.equal(a.raw("B19"), "ИТОГО", "two rows for two goods, no row for the invoice-only line");
  });

  it("shipment-level facts are shared, vehicle facts are not", () => {
    for (const set of [forA, forB]) {
      const text = contentOf(set.find(document => document.output === "workbook")!.bytes);
      assert.ok(text.includes("CONTRACT-77"));
      assert.ok(text.includes("Город-Отправки"));
    }
  });

  it("does not compare an invoice line with a single vehicle's share of it", () => {
    const model = buildExportModel(assemble("tA"));
    assert.equal(model.invoiceNotes.some(note => /в инвойсе/.test(note)), false, "no false quantity mismatch for a vehicle that carries part of the invoice");
  });

  it("form sheets keep the layout, formulas and the +3% / 25 kg rules of the reference", () => {
    const reference = XlsxWorkbook.load(fixtureBytes());
    const book = XlsxWorkbook.load(forB.find(document => document.output === "workbook")!.bytes);
    for (const name of ["CMR", "ТТН", "фура, водила", "Инструкция"]) {
      assert.deepEqual(book.sheet(name).mergeRanges.sort(), reference.sheet(name).mergeRanges.sort(), `${name} merges`);
      assert.deepEqual(book.sheet(name).columnWidths(), reference.sheet(name).columnWidths(), `${name} widths`);
      for (let row = 1; row <= 60; row++) assert.equal(book.sheet(name).rowHeight(row), reference.sheet(name).rowHeight(row), `${name} row ${row}`);
    }
    const packing = book.sheet("упаков.лист");
    for (const row of [12, 13]) {
      assert.match(packing.formula(`G${row}`) ?? "", /^F\d+\*1\.03$/, "primary packaging factor is unchanged");
      assert.match(packing.formula(`K${row}`) ?? "", /^J\d+\+I\d+\*25$/, "25 kg per pallet is unchanged");
    }
  });
});

describe("blocking when cargo is not distributed", () => {
  it("blocks every vehicle while part of the cargo has no vehicle, and explains it", () => {
    const loose = [...allItems, item("i-loose", "pa1", null, 300)];
    for (const id of ["tA", "tB"]) {
      assert.throws(() => assembleGenerationData({ shipment, items: loose, transports: vehicles, transportId: id, products, identifiers, packaging: allPackaging, priceByItem: new Map(), includePrices: false, sources: [] }),
        (error: unknown) => error instanceof Error && /часть груза не распределена/.test(error.message) && /300 шт\./.test(error.message) && /«Позиции»/.test(error.message));
    }
  });

  it("blocks a vehicle that carries nothing and asks to choose another or to bind cargo", () => {
    const onlyA = allItems.filter(row => row.shipment_transport_id === "tA");
    assert.throws(() => assembleGenerationData({ shipment, items: onlyA, transports: vehicles, transportId: "tB", products, identifiers, packaging: allPackaging, priceByItem: new Map(), includePrices: false, sources: [] }), /не закреплён груз/);
  });

  it("asks for a vehicle when there are several, and lets a single-vehicle shipment through unchanged", () => {
    assert.throws(() => assembleGenerationData({ shipment, items: allItems, transports: vehicles, products, identifiers, packaging: allPackaging, priceByItem: new Map(), includePrices: false, sources: [] }), /Выберите автомобиль/);
    const single = assembleGenerationData({ shipment, items: allItems.map(row => ({ ...row, shipment_transport_id: null })), transports: [vehicles[0]], transportId: "tA", products, identifiers, packaging: allPackaging, priceByItem: new Map(), includePrices: false, sources: [] });
    assert.equal(single.selectedItems.length, 4, "one vehicle takes the whole shipment even if nothing was allocated");
    assert.equal(single.data.vehicle_scoped, false);
  });

  it("reads the state of every vehicle for the page", () => {
    const states = vehicleSetStates(vehicles as never, allItems as never);
    assert.deepEqual(states.map(state => [state.vehicleId, state.cargoLines, state.state]), [["tA", 2, "ready"], ["tB", 2, "ready"]]);
    assert.equal(cargoBlocker(vehicles as never, allItems as never, "tA"), null);
    assert.equal(unallocatedCargo(vehicles as never, [...allItems, item("x", "pa1", null, 1)] as never).length, 1);
    assert.equal(unallocatedCargo([vehicles[0]] as never, [item("x", "pa1", null, 1)] as never).length, 0, "a single vehicle has no 'unallocated' notion");
    assert.equal(cargoBlocker(vehicles as never, [item("x", "pa1", null, 1)] as never, "tA") !== null, true);
  });

  it("the pre-flight stays silent about unallocated cargo once everything is bound", () => {
    const model = buildExportModel({ ...assemble("tA"), ...NUMBERS.tA });
    assert.equal(preflightExport(model, ["cmr", "ttn", "packing_list"], { includePrices: true }).ready, true);
  });
});

describe("numbers are typed by the user for each vehicle", () => {
  const rows: IssuedRow[] = [
    { selected: "tA", cmr: "CMR-1001", ttn: "TTN-1001", pl: "PL-1001", type: "cmr", at: "2030-01-02" },
    { selected: "tA", cmr: "CMR-1001", ttn: "TTN-1001", pl: "PL-1001", type: "ttn", at: "2030-01-02" },
    { selected: "tA", cmr: "CMR-1001", ttn: "TTN-1001", pl: "PL-1001", type: "packing_list", at: "2030-01-03" },
  ];
  const labelOf = (id: string) => id === "tA" ? "№1 · PLATE-A" : id;

  it("does not issue without the three numbers", () => {
    assert.throws(() => buildExportDocuments(fixtureBytes(), { ...assemble("tB") }, ["cmr", "ttn", "packing_list"], { includePrices: true }), PreflightError);
    const partly = { ...assemble("tB"), cmr_number: "CMR-2002" };
    assert.throws(() => buildExportDocuments(fixtureBytes(), partly, ["cmr", "ttn", "packing_list"], { includePrices: true }), (error: unknown) => error instanceof PreflightError && /TTN|ТТН/i.test(error.message) === true);
  });

  it("never reuses a number printed for another vehicle, but allows re-issuing for the same vehicle", () => {
    assert.deepEqual(findNumberConflicts(rows, { id: "tB", label: "" }, { cmr_number: "cmr-1001" }, labelOf).length, 1, "case-insensitive");
    const messages = findNumberConflicts(rows, { id: "tB", label: "" }, { cmr_number: "CMR-1001", ttn_number: "TTN-2002", packing_list_number: "PL-1001" }, labelOf);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /№1 · PLATE-A/);
    assert.deepEqual(findNumberConflicts(rows, { id: "tA", label: "" }, NUMBERS.tA, labelOf), []);
    assert.deepEqual(findNumberConflicts(rows, { id: "tB", label: "" }, NUMBERS.tB, labelOf), []);
  });

  it("shows which documents were already issued for which vehicle", () => {
    const sets = issuedSets(rows);
    assert.deepEqual([...sets.get("tA")!.cmr], ["CMR-1001"]);
    assert.deepEqual([...sets.get("tA")!.packing_list], ["PL-1001"]);
    assert.equal(sets.get("tA")!.lastAt, "2030-01-03");
    assert.equal(sets.has("tB"), false);
  });
});

describe("make and plate are kept apart", () => {
  it("separates a make and a plate that a document wrote together", () => {
    assert.deepEqual(separateVehicle("", "SCANIA 754BA04"), { plate: "754BA04", make: "SCANIA" });
    assert.deepEqual(separateVehicle("754 BA 04 SCANIA", ""), { plate: "754BA04", make: "SCANIA" });
    assert.deepEqual(separateVehicle("66DLA04", "Прицеп 66DLA04 SCHMITZ S.KO 24/1"), { plate: "66DLA04", make: "SCHMITZ S.KO 24/1" });
    assert.deepEqual(separateVehicle("A123BC77", "VOLVO FH16"), { plate: "A123BC77", make: "VOLVO FH16" });
    assert.deepEqual(separateVehicle("754BA04", "SCANIA"), { plate: "754BA04", make: "SCANIA" }, "already separate: unchanged");
  });

  it("leaves values that do not look like a plate exactly as typed", () => {
    assert.deepEqual(separateVehicle("ВРЕМЕННЫЙ-1", "Самосвал"), { plate: "ВРЕМЕННЫЙ-1", make: "Самосвал" });
    assert.deepEqual(separateVehicle("", ""), { plate: "", make: "" });
  });

  it("puts each value under its own caption in the issued documents", () => {
    // A vehicle whose card has no plate or make yet; the confirmed document wrote make and plate together.
    const blank = { ...vehicles[0], vehicle_plate: null, vehicle_make: null, trailer_plate: null, trailer_make: null };
    const { data: assembled } = assembleGenerationData({
      shipment, items: allItems.map(row => ({ ...row, shipment_transport_id: null })), transports: [blank], transportId: "tA", products, identifiers, packaging: allPackaging, priceByItem: new Map(), includePrices: false,
      sources: [{ confirmed_data: { vehicle_make: "SCANIA 754BA04", trailer_make: "Прицеп 66DLA04 SCHMITZ S.KO 24/1", loading_address: "Склад-1", unloading_address: "Склад-2", shipping_date: "2030-01-15" }, shipment_transport_id: null }],
    });
    const [workbook] = buildExportDocuments(fixtureBytes(), { ...assembled, ...NUMBERS.tA }, ["workbook"], { includePrices: false });
    const book = XlsxWorkbook.load(workbook.bytes);
    const input = book.sheet("данные");
    assert.deepEqual([input.raw("C7"), input.raw("C8"), input.raw("C9"), input.raw("C10")], ["754BA04", "SCANIA", "66DLA04", "SCHMITZ S.KO 24/1"]);
    const packing = book.sheet("упаков.лист");
    assert.equal(packing.raw("B5"), "Гос.номер прицепа");
    assert.equal(packing.raw("C5"), "66DLA04", "the trailer plate stands under «Гос.номер прицепа»");
    assert.equal(packing.raw("B6"), "Марка прицепа");
    assert.equal(packing.raw("C6"), "SCHMITZ S.KO 24/1", "the trailer make stands under «Марка прицепа»");
    assert.equal(packing.raw("C3"), "754BA04");
    assert.equal(packing.raw("C4"), "SCANIA");
    assert.equal(book.sheet("CMR").raw("A51"), "Автомобиль SCANIA 754BA04, Прицеп 66DLA04 SCHMITZ S.KO 24/1");
    assert.equal(book.sheet("ТТН").raw("N19"), "66DLA04");
    assert.equal(book.sheet("ТТН").raw("P19"), "SCHMITZ S.KO 24/1");
  });
});
