import { cargoBlocker } from "./vehicle-sets.ts";

export type ScopedRow = { id?: unknown; shipment_transport_id?: unknown; sequence_no?: unknown };

/**
 * Chooses the vehicle and the cargo a document set is built from.
 * - one vehicle (or none): the whole shipment, as before;
 * - several vehicles: a vehicle must be chosen, the whole cargo must be distributed, and only the cargo bound
 *   to the chosen vehicle is used — never a share of what is unallocated.
 */
export function selectGenerationScope<TItem extends ScopedRow, TTransport extends ScopedRow>(
  items: TItem[],
  transports: TTransport[],
  transportId?: string,
) {
  const selectedTransport = transportId ? transports.find(row => row.id === transportId) : undefined;
  if (transportId && !selectedTransport) throw new Error("Выбранный автомобиль не относится к поставке или отменён");
  if (!transportId && transports.length > 1) throw new Error("Выберите автомобиль: для поставки с несколькими машинами комплект формируется отдельно по каждой машине");
  if (selectedTransport) {
    const blocker = cargoBlocker(
      transports.map(row => ({ id: String(row.id), sequence_no: Number(row.sequence_no) })),
      items.map(row => ({ shipment_transport_id: row.shipment_transport_id as string | null, ordered_quantity: (row as { ordered_quantity?: number | string | null }).ordered_quantity, uom: (row as { uom?: string | null }).uom })),
      transportId,
    );
    if (blocker) throw new Error(blocker);
  }
  const selectedItems = selectedTransport && transports.length > 1 ? items.filter(item => item.shipment_transport_id === transportId) : selectedTransport ? items.filter(item => !item.shipment_transport_id || item.shipment_transport_id === transportId) : items;
  if (selectedTransport && !selectedItems.length) throw new Error("На выбранный автомобиль не распределены товары");
  return { selectedTransport, selectedItems };
}
