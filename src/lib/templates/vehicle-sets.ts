// One document set (CMR, ТТН, packing list) is issued per vehicle. This module decides, in plain terms,
// whether a vehicle's set can be issued and explains why not. Pure: used by the generator, the page and tests.

import { describeTransport } from "../shipments/transport-form.ts";

export type SetVehicle = {
  id: string;
  sequence_no: number;
  vehicle_plate?: string | null;
  vehicle_make?: string | null;
  trailer_plate?: string | null;
  trailer_make?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
  carrier_name?: string | null;
  status?: string | null;
};

export type SetCargo = { id?: string; shipment_transport_id?: string | null; ordered_quantity?: number | string | null; uom?: string | null };

export type VehicleSetState = {
  vehicleId: string;
  label: string;
  cargoLines: number;
  /** "ready": cargo is bound to this vehicle; "no_cargo": nothing is bound to it yet. */
  state: "ready" | "no_cargo";
};

const activeOnly = <T extends { status?: string | null }>(rows: T[]) => rows.filter(row => row.status !== "cancelled");

export function vehicleSetStates(vehicles: SetVehicle[], cargo: SetCargo[]): VehicleSetState[] {
  return activeOnly(vehicles).map(vehicle => {
    const cargoLines = cargo.filter(item => item.shipment_transport_id === vehicle.id).length;
    return { vehicleId: vehicle.id, label: describeTransport(vehicle), cargoLines, state: cargoLines ? "ready" : "no_cargo" };
  });
}

export const unallocatedCargo = (vehicles: SetVehicle[], cargo: SetCargo[]) =>
  activeOnly(vehicles).length > 1 ? cargo.filter(item => !item.shipment_transport_id) : [];

const quantityLabel = (cargo: SetCargo[]) => {
  const byUnit = new Map<string, number>();
  for (const item of cargo) byUnit.set(item.uom || "piece", (byUnit.get(item.uom || "piece") ?? 0) + (Number(item.ordered_quantity) || 0));
  const names: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слоёв", pallet: "пал.", truck: "авто" };
  return [...byUnit].map(([unit, total]) => `${total.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} ${names[unit] ?? unit}`).join(", ");
};

/**
 * Why the set of one vehicle cannot be issued, or null when it can. With several vehicles the whole cargo must be
 * distributed first: a document set for one vehicle must show exactly what that vehicle carries, and a shipment that
 * still has cargo without a vehicle is not finished being planned. Nothing is distributed automatically.
 */
export function cargoBlocker(vehicles: SetVehicle[], cargo: SetCargo[], transportId?: string): string | null {
  const active = activeOnly(vehicles);
  if (active.length <= 1) return null;
  const loose = unallocatedCargo(active, cargo);
  if (loose.length) {
    return `Формирование заблокировано: в поставке несколько автомобилей (${active.length}), а часть груза не распределена между ними (позиций: ${loose.length}, ${quantityLabel(loose)}). Закрепите весь груз за автомобилями на вкладке «Позиции» — документы формируются только на груз, закреплённый за конкретным автомобилем.`;
  }
  const vehicle = transportId ? active.find(item => item.id === transportId) : undefined;
  if (vehicle && !cargo.some(item => item.shipment_transport_id === vehicle.id)) {
    return `Формирование заблокировано: за автомобилем ${describeTransport(vehicle)} не закреплён груз. Закрепите за ним товары на вкладке «Позиции» или выберите другой автомобиль.`;
  }
  return null;
}

// ---- issued sets and number control ----------------------------------------------------------------------------

export type IssuedRow = {
  /** document_generations.fields_snapshot->>selected_transport_id */
  selected: string | null;
  cmr: string | null;
  ttn: string | null;
  pl: string | null;
  /** Type code of the issued document: cmr | ttn | packing_list | shipment_workbook. */
  type: string | null;
  at?: string | null;
};

export type IssuedSet = { cmr: Set<string>; ttn: Set<string>; packing_list: Set<string>; workbook: boolean; lastAt: string | null };

const KINDS = [
  { type: "cmr", field: "cmr", key: "cmr_number", label: "CMR" },
  { type: "ttn", field: "ttn", key: "ttn_number", label: "ТТН" },
  { type: "packing_list", field: "pl", key: "packing_list_number", label: "упаковочного листа" },
] as const;

/** Which documents were already issued for which vehicle (from the snapshots stored with every generation). */
export function issuedSets(rows: IssuedRow[]) {
  const result = new Map<string, IssuedSet>();
  for (const row of rows) {
    if (!row.selected) continue;
    const set = result.get(row.selected) ?? { cmr: new Set<string>(), ttn: new Set<string>(), packing_list: new Set<string>(), workbook: false, lastAt: null };
    for (const kind of KINDS) {
      const value = row[kind.field]?.trim();
      if (value && (row.type === kind.type || row.type === "shipment_workbook")) set[kind.type].add(value);
    }
    if (row.type === "shipment_workbook") set.workbook = true;
    if (row.at && (!set.lastAt || row.at > set.lastAt)) set.lastAt = row.at;
    result.set(row.selected, set);
  }
  return result;
}

const sameNumber = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A CMR, ТТН or packing-list number printed for one vehicle must not be reused for another vehicle of the same
 * shipment. Re-issuing a set for the same vehicle with the same number is fine. Returns readable messages.
 */
export function findNumberConflicts(
  rows: IssuedRow[],
  vehicle: { id: string; label: string },
  numbers: { cmr_number?: string; ttn_number?: string; packing_list_number?: string },
  labelOf: (transportId: string) => string,
) {
  const messages: string[] = [];
  for (const kind of KINDS) {
    const entered = (numbers[kind.key] ?? "").trim();
    if (!entered) continue;
    const clash = rows.find(row => row.selected && row.selected !== vehicle.id && row[kind.field] && sameNumber(row[kind.field] as string, entered) && (row.type === kind.type || row.type === "shipment_workbook"));
    if (clash?.selected) messages.push(`Номер ${kind.label} «${entered}» уже выпущен для автомобиля ${labelOf(clash.selected)}. У каждого автомобиля свои номера документов.`);
  }
  return messages;
}
