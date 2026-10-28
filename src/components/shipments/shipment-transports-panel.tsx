import Link from "next/link";
import { PalletWeightForm } from "./pallet-weight-form";
import type { CargoOperation } from "@/lib/shipments/pallet-weight";
import { addShipmentTransport, changeShipmentTransportStatus, removeShipmentTransport, updateShipmentTransport } from "@/app/shipments/actions";
import { sumShipmentLoadLines, type ShipmentLoadLine } from "@/lib/shipments/load-summary";
import { describeTransport, duplicatePlates } from "@/lib/shipments/transport-form";

export type PanelTransport = {
  purchase_pallet_tare_kg?: number | null;
  sale_pallet_tare_kg?: number | null;
  id: string;
  sequence_no: number;
  status: string;
  planned_loading_date: string | null;
  planned_arrival_date: string | null;
  temperature_setpoint: string | null;
  notes: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  driver_document: string | null;
  vehicle_plate: string | null;
  vehicle_make: string | null;
  trailer_plate: string | null;
  trailer_make: string | null;
  carrier_name: string | null;
};

const STATUS: Record<string, string> = {
  planned: "Запланирован", loading: "На загрузке", in_transit: "В пути", at_customs: "На таможне", arrived: "Прибыл", unloaded: "Разгружен", cancelled: "Отменён",
};

const number = (value: number | null, digits = 0) => value === null ? "—" : value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
const date = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "";

function Fields({ transport }: { transport?: PanelTransport }) {
  return <>
    <label>Перевозчик<input name="carrier_name" maxLength={200} defaultValue={transport?.carrier_name ?? ""} placeholder="ТОО «Перевозчик»"/></label>
    <label>Водитель<input name="driver_name" maxLength={200} defaultValue={transport?.driver_name ?? ""} placeholder="Фамилия И.О."/></label>
    <label>Телефон водителя<input name="driver_phone" maxLength={60} defaultValue={transport?.driver_phone ?? ""}/></label>
    <label>Документ водителя<input name="driver_document" maxLength={250} defaultValue={transport?.driver_document ?? ""} placeholder="удостоверение, кем и когда выдано"/></label>
    <label>Госномер автомобиля<input name="vehicle_plate" maxLength={40} defaultValue={transport?.vehicle_plate ?? ""}/></label>
    <label>Марка автомобиля<input name="vehicle_make" maxLength={80} defaultValue={transport?.vehicle_make ?? ""}/></label>
    <label>Госномер прицепа<input name="trailer_plate" maxLength={40} defaultValue={transport?.trailer_plate ?? ""}/></label>
    <label>Марка прицепа<input name="trailer_make" maxLength={80} defaultValue={transport?.trailer_make ?? ""}/></label>
    <label>План загрузки<input name="planned_loading_date" type="date" defaultValue={transport?.planned_loading_date ?? ""}/></label>
    <label>План прибытия<input name="planned_arrival_date" type="date" defaultValue={transport?.planned_arrival_date ?? ""}/></label>
    <label>Температура<input name="temperature_setpoint" maxLength={50} defaultValue={transport?.temperature_setpoint ?? ""} placeholder="+15…+25 °C"/></label>
    <label>Примечание<input name="notes" maxLength={500} defaultValue={transport?.notes ?? ""} placeholder="Рейс, особые условия"/></label>
  </>;
}

export function ShipmentTransportsPanel({ shipmentId, transports, receivedIds, canEdit, canReceive, loadLines, operation = "purchase" }: {
  operation?: CargoOperation;
  shipmentId: string;
  transports: PanelTransport[];
  receivedIds: string[];
  canEdit: boolean;
  canReceive: boolean;
  loadLines: ShipmentLoadLine[];
}) {
  const received = new Set(receivedIds);
  const active = transports.filter(transport => transport.status !== "cancelled");
  const duplicates = duplicatePlates(transports);
  const unallocated = loadLines.filter(line => !line.transportId);
  return <section className="panel admin-section" id="transports">
    <div className="panel-heading"><div><p className="eyebrow">Логистика</p><h2>Автомобили поставки</h2></div><span className="page-count">{active.length}</span></div>
    <p className="form-help">В одной поставке может быть несколько автомобилей. У каждого свои водитель, номера, марки и перевозчик. Груз распределяет сотрудник вручную в блоке «Позиции»: система сама ничего не распределяет.</p>
    {duplicates.length > 0 && <div className="login-error admin-message">Один и тот же госномер указан у нескольких автомобилей: {duplicates.join(", ")}.</div>}
    {canEdit && <details className="transport-add">
      <summary className="primary compact">Добавить автомобиль</summary>
      <form action={addShipmentTransport} className="shipment-subform transport-subform transport-fields"><input type="hidden" name="shipment_id" value={shipmentId}/><Fields/><button className="primary" type="submit">Добавить автомобиль</button></form>
    </details>}
    {active.length > 1 && unallocated.length > 0 && <div className="setup-notice">Не распределено по автомобилям: {unallocated.length} поз. ({number(sumShipmentLoadLines(unallocated).pieces)} шт.). Для документов по автомобилю учитывается только груз, закреплённый за ним.</div>}
    <div className="compact-list">{transports.map(transport => {
      const isReceived = received.has(transport.id);
      const load = sumShipmentLoadLines(loadLines.filter(line => line.transportId === transport.id));
      const cargo = loadLines.filter(line => line.transportId === transport.id).length;
      return <article className="transport-card" key={transport.id}>
        <div className="transport-row">
          <div><strong>Автомобиль {describeTransport(transport)}</strong><small>{transport.carrier_name || "Перевозчик не указан"}{transport.notes ? ` · ${transport.notes}` : ""}</small></div>
          <span className={`status transport-${transport.status}`}>{STATUS[transport.status] ?? transport.status}</span>
          <div><strong>{date(transport.planned_loading_date) || "—"}</strong><small>план загрузки</small></div>
          <div className="transport-actions">
            {canReceive && (transport.status === "arrived" || isReceived) && <Link className={isReceived ? "ghost button-link compact" : "primary button-link compact"} href={`/shipments/${shipmentId}/receiving?transport=${transport.id}`}>{isReceived ? "Приёмка завершена" : "Принять товар"}</Link>}
            {canEdit && !isReceived && <form action={changeShipmentTransportStatus} className="transport-status-form"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="transport_id" value={transport.id}/><select name="status" defaultValue={transport.status} aria-label={`Статус автомобиля №${transport.sequence_no}`}>{Object.entries(STATUS).filter(([value]) => value !== "unloaded" || transport.status === "unloaded").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="ghost compact" type="submit">Сохранить</button></form>}
          </div>
        </div>
        <PalletWeightForm shipmentId={shipmentId} transportId={transport.id} operation={operation} purchase={transport.purchase_pallet_tare_kg??null} sale={transport.sale_pallet_tare_kg??null} boxedKg={load.boxedGrossWeightKg} pallets={load.pallets} canEdit={canEdit&&transport.status!=="cancelled"}/>
        <dl className="transport-facts">
          <div><dt>Водитель</dt><dd>{transport.driver_name || "—"}{transport.driver_phone ? `, ${transport.driver_phone}` : ""}</dd></div>
          <div><dt>Документ водителя</dt><dd>{transport.driver_document || "—"}</dd></div>
          <div><dt>Автомобиль</dt><dd>{[transport.vehicle_plate, transport.vehicle_make].filter(Boolean).join(" · ") || "—"}</dd></div>
          <div><dt>Прицеп</dt><dd>{[transport.trailer_plate, transport.trailer_make].filter(Boolean).join(" · ") || "—"}</dd></div>
          <div><dt>Груз</dt><dd>{cargo ? `${cargo} поз. · ${number(load.pieces)} шт. · ${number(load.boxes)} кор. · ${number(load.pallets, 1)} пал. · брутто ${number(load.grossWithPalletsKg, 1)} кг` : "Груз не закреплён"}</dd></div>
        </dl>
        {canEdit && transport.status !== "cancelled" && <details className="transport-edit">
          <summary className="ghost compact">Изменить данные</summary>
          <form action={updateShipmentTransport} className="shipment-subform transport-subform transport-fields"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="transport_id" value={transport.id}/><Fields transport={transport}/><button className="primary" type="submit">Сохранить</button></form>
        </details>}
        {canEdit && <details className="transport-remove">
          <summary className="ghost compact">Удалить</summary>
          <form action={removeShipmentTransport} className="transport-remove-form"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="transport_id" value={transport.id}/><p className="form-help">Автомобиль можно удалить, пока за ним нет груза, приёмки и начатых этапов. Иначе верните груз в нераспределённые или отмените автомобиль. Документы автомобиля останутся в поставке.</p><button className="danger compact" type="submit">Удалить автомобиль №{transport.sequence_no}</button></form>
        </details>}
      </article>;
    })}{!transports.length && <div className="empty-state">Добавьте первый автомобиль, чтобы закрепить за ним груз и документы.</div>}</div>
  </section>;
}
