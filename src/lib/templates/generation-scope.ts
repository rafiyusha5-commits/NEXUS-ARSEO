export type ScopedRow = { id?: unknown; shipment_transport_id?: unknown; sequence_no?: unknown };

export function selectGenerationScope<TItem extends ScopedRow, TTransport extends ScopedRow>(
  items: TItem[],
  transports: TTransport[],
  transportId?: string,
) {
  const selectedTransport = transportId ? transports.find(row => row.id === transportId) : undefined;
  if (transportId && !selectedTransport) throw new Error("Выбранный автомобиль не относится к поставке или отменён");
  if (!transportId && transports.length > 1) throw new Error("Выберите автомобиль: для поставки с несколькими машинами комплект формируется отдельно по каждой машине");
  const selectedItems = selectedTransport ? items.filter(item => item.shipment_transport_id === transportId) : items;
  if (selectedTransport && !selectedItems.length) throw new Error("На выбранный автомобиль не распределены товары");
  return { selectedTransport, selectedItems };
}
