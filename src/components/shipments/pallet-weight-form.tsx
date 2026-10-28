"use client";

import { useState } from "react";
import { updateTransportPalletWeight } from "@/app/shipments/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { fullCargoGross, operationLabel, validPalletWeight, type CargoOperation } from "@/lib/shipments/pallet-weight";

export function PalletWeightForm({ shipmentId, transportId, operation, purchase, sale, boxedKg, pallets, canEdit }: {
  shipmentId: string; transportId: string; operation: CargoOperation; purchase: number | null; sale: number | null;
  boxedKg: number | null; pallets: number | null; canEdit: boolean;
}) {
  const [selected, setSelected] = useState(operation);
  const [weight, setWeight] = useState(String((operation === "purchase" ? purchase : sale) ?? ""));
  const gross = fullCargoGross(boxedKg, pallets, validPalletWeight(weight));
  const kg = (n: number | null) => n === null ? "не рассчитано" : `${n.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} кг`;
  return <form action={updateTransportPalletWeight} className="shipment-subform transport-fields">
    <input type="hidden" name="shipment_id" value={shipmentId}/>
    <input type="hidden" name="transport_id" value={transportId}/>
    <label>Операция расчёта<select name="cargo_operation" value={selected} onChange={e => {
      const next = e.target.value as CargoOperation;
      setSelected(next); setWeight(String((next === "purchase" ? purchase : sale) ?? ""));
    }}>{Object.entries(operationLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Вес одной пустой паллеты, кг<input name="pallet_tare_kg" type="number" min={20} max={25} step="0.01" required value={weight} onChange={e => setWeight(e.target.value)} readOnly={!canEdit}/></label>
    <p className="form-help">Брутто в коробах: {kg(boxedKg)}. Паллет по упаковке: {pallets ?? "не рассчитано"}. С паллетами: <strong>{kg(gross)}</strong>.</p>
    <p className="form-help">Вес сохраняется только для выбранной операции этого автомобиля. Расчёт продажи здесь — предварительный по его грузу; фактический груз и машину отправки клиенту оформляют отдельно. Подтверждённые документы не переписываются.</p>
    {canEdit && <PendingSubmitButton className="ghost compact" pendingText="Сохраняем…">Сохранить вес паллеты</PendingSubmitButton>}
  </form>;
}
