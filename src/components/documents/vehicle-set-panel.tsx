import Link from "next/link";
import { cargoBlocker, vehicleSetStates, type IssuedSet, type SetCargo, type SetVehicle } from "@/lib/templates/vehicle-sets";
import { describeTransport } from "@/lib/shipments/transport-form";

export type PanelCargoLine = { name: string; quantity: string };

const numbers = (set?: IssuedSet) => set ? [
  set.cmr.size ? `CMR № ${[...set.cmr].join(", ")}` : "",
  set.ttn.size ? `ТТН № ${[...set.ttn].join(", ")}` : "",
  set.packing_list.size ? `упаковочный лист № ${[...set.packing_list].join(", ")}` : "",
].filter(Boolean).join(" · ") : "";

function VehicleFacts({ vehicle }: { vehicle: SetVehicle }) {
  return <dl className="transport-facts">
    <div><dt>Автомобиль</dt><dd>{vehicle.vehicle_plate || "госномер не указан"}{vehicle.vehicle_make ? ` · ${vehicle.vehicle_make}` : ""}</dd></div>
    <div><dt>Прицеп</dt><dd>{vehicle.trailer_plate || "—"}{vehicle.trailer_make ? ` · ${vehicle.trailer_make}` : ""}</dd></div>
    <div><dt>Водитель</dt><dd>{vehicle.driver_name || "—"}{vehicle.driver_phone ? `, ${vehicle.driver_phone}` : ""}</dd></div>
    <div><dt>Перевозчик</dt><dd>{vehicle.carrier_name || "—"}</dd></div>
  </dl>;
}

export function VehicleSetPanel({ shipmentId, templateId, prices, vehicles, cargo, selectedId, issued, cargoLines }: {
  shipmentId: string;
  templateId: string;
  prices: boolean;
  vehicles: SetVehicle[];
  cargo: SetCargo[];
  selectedId: string;
  issued: Record<string, IssuedSet>;
  /** The goods and quantities that will go into the selected vehicle's set. */
  cargoLines?: PanelCargoLine[];
}) {
  const active = vehicles.filter(vehicle => vehicle.status !== "cancelled");
  if (!active.length) return <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Комплект документов</p><h2>Автомобили</h2></div></div><div className="login-error admin-message">В поставке нет автомобилей. Добавьте автомобиль на вкладке «Доставка» — комплект CMR, ТТН и упаковочного листа формируется на каждый автомобиль.</div></section>;
  const states = vehicleSetStates(active, cargo);
  const selected = active.find(vehicle => vehicle.id === selectedId);
  const blocker = cargoBlocker(active, cargo, selected?.id);
  const link = (id: string) => `/templates/${templateId}/generate?shipment=${shipmentId}&transport=${id}&prices=${prices ? "1" : "0"}`;
  return <section className="panel admin-section vehicle-set-panel">
    <div className="panel-heading"><div><p className="eyebrow">Комплект документов</p><h2>{active.length > 1 ? "Комплект на каждый автомобиль" : "Комплект для автомобиля"}</h2></div><span className="page-count">{active.length}</span></div>
    {active.length > 1 && <p className="form-help">CMR, ТТН и упаковочный лист формируются отдельно для каждого автомобиля и содержат только его данные и закреплённый за ним груз. Номера документов вводятся вручную и у каждого автомобиля свои.</p>}
    <div className="compact-list">{active.map(vehicle => {
      const state = states.find(item => item.vehicleId === vehicle.id);
      const done = numbers(issued[vehicle.id]);
      const isSelected = vehicle.id === selectedId;
      return <article className={`transport-card${isSelected ? " is-selected" : ""}`} key={vehicle.id}>
        <div className="transport-row">
          <div><strong>Автомобиль {describeTransport(vehicle)}</strong><small>{vehicle.carrier_name || "Перевозчик не указан"}</small></div>
          <span className={state?.state === "ready" ? "status transport-arrived" : "status transport-cancelled"}>{state?.state === "ready" ? `Груз закреплён: ${state.cargoLines} поз.` : "Груз не закреплён"}</span>
          <div><strong>{done ? "Комплект выпущен" : "Комплект не выпускался"}</strong><small>{done || "номера вводятся при формировании"}</small></div>
          <div className="transport-actions">{active.length > 1 && <Link className={isSelected ? "ghost button-link compact" : "primary button-link compact"} href={link(vehicle.id)}>{isSelected ? "Выбран" : "Подготовить комплект"}</Link>}</div>
        </div>
        {isSelected && <VehicleFacts vehicle={vehicle}/>}
      </article>;
    })}</div>
    {active.length > 1 && !selected && <div className="setup-notice">Выберите автомобиль, для которого нужно сформировать комплект.</div>}
    {blocker && <div className="login-error admin-message"><strong>{blocker}</strong><div><Link href={`/shipments/${shipmentId}#transports`}>Открыть поставку и распределить груз</Link></div></div>}
    {selected && !blocker && cargoLines && <>
      <h3>Груз автомобиля {describeTransport(selected)}: попадёт в документы</h3>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Товар</th><th>Количество</th></tr></thead><tbody>{cargoLines.map((line, index) => <tr key={`${line.name}-${index}`}><td>{line.name}</td><td>{line.quantity}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
