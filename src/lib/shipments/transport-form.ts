// Form rules for the vehicles of a shipment. Pure: shared by the server actions and the tests.
// The database repeats these limits (private.clean_transport_text), this layer only gives clear messages early.

export const TRANSPORT_TEXT_FIELDS = [
  { key: "driver_name", label: "Водитель", max: 200 },
  { key: "driver_phone", label: "Телефон водителя", max: 60 },
  { key: "driver_document", label: "Документ водителя", max: 250 },
  { key: "vehicle_plate", label: "Госномер автомобиля", max: 40 },
  { key: "vehicle_make", label: "Марка автомобиля", max: 80 },
  { key: "trailer_plate", label: "Госномер прицепа", max: 40 },
  { key: "trailer_make", label: "Марка прицепа", max: 80 },
  { key: "carrier_name", label: "Перевозчик", max: 200 },
  { key: "temperature_setpoint", label: "Температурный режим", max: 50 },
  { key: "notes", label: "Примечание", max: 500 },
] as const;

export const TRANSPORT_DATE_FIELDS = [
  { key: "planned_loading_date", label: "План загрузки" },
  { key: "planned_arrival_date", label: "План прибытия" },
] as const;

export type TransportValues = Record<string, string>;

export type TransportFormResult = { ok: true; values: TransportValues } | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads every vehicle field from a form (missing fields become empty strings, which clear a value on update). */
export function readTransportForm(get: (key: string) => string): TransportFormResult {
  const values: TransportValues = {};
  for (const field of TRANSPORT_TEXT_FIELDS) {
    const value = get(field.key).replace(/\s+/g, " ").trim();
    if (value.length > field.max) return { ok: false, error: `Поле «${field.label}» длиннее ${field.max} символов` };
    values[field.key] = value;
  }
  for (const field of TRANSPORT_DATE_FIELDS) {
    const value = get(field.key).trim();
    if (value && (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))) return { ok: false, error: `Поле «${field.label}» должно быть датой` };
    values[field.key] = value;
  }
  if (values.planned_loading_date && values.planned_arrival_date && values.planned_arrival_date < values.planned_loading_date) {
    return { ok: false, error: "Плановое прибытие раньше плановой загрузки" };
  }
  return { ok: true, values };
}

/** Arguments of create_shipment_transport (empty values stay null). */
export function createTransportArguments(shipmentId: string, values: TransportValues) {
  const orNull = (key: string) => values[key] || null;
  return {
    p_shipment_id: shipmentId,
    p_planned_loading_date: orNull("planned_loading_date"),
    p_planned_arrival_date: orNull("planned_arrival_date"),
    p_temperature_setpoint: orNull("temperature_setpoint"),
    p_notes: orNull("notes"),
    p_driver_name: orNull("driver_name"),
    p_driver_phone: orNull("driver_phone"),
    p_driver_document: orNull("driver_document"),
    p_vehicle_plate: orNull("vehicle_plate"),
    p_vehicle_make: orNull("vehicle_make"),
    p_trailer_plate: orNull("trailer_plate"),
    p_trailer_make: orNull("trailer_make"),
    p_carrier_name: orNull("carrier_name"),
  };
}

/** The patch sent to update_shipment_transport: every field of the form, an empty string clears the value. */
export function transportChanges(values: TransportValues) {
  const changes: Record<string, string> = {};
  for (const field of [...TRANSPORT_TEXT_FIELDS, ...TRANSPORT_DATE_FIELDS]) changes[field.key] = values[field.key] ?? "";
  return changes;
}

export const normalizePlate = (value: unknown) => String(value ?? "").toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/g, "");

export type TransportSummary = {
  sequence_no: number;
  vehicle_plate?: string | null;
  driver_name?: string | null;
  carrier_name?: string | null;
  trailer_plate?: string | null;
};

/** One line for lists and selects: «№2 · 222CCC22 · Петров П.П.». */
export function describeTransport(transport: TransportSummary) {
  return [`№${transport.sequence_no}`, transport.vehicle_plate, transport.driver_name].filter(Boolean).join(" · ");
}

/** Vehicles that share a plate (ignoring spaces, dashes and case) would be refused by the database; flag them early. */
export function duplicatePlates(transports: Array<TransportSummary & { status?: string }>) {
  const seen = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const transport of transports) {
    if (transport.status === "cancelled") continue;
    const key = normalizePlate(transport.vehicle_plate);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.set(key, transport.sequence_no);
  }
  return [...duplicates];
}
