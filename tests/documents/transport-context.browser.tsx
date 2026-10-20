import { createRoot } from "react-dom/client";
import { SourceTransportContext } from "../../src/components/documents/source-transport-context";
const vehicles = [{ id: "A", label: "Автомобиль 1 · SYNTH-A" }, { id: "B", label: "Автомобиль 2 · SYNTH-B" }];
const action = async (form: FormData) => { document.getElementById("result")!.textContent = `Выбрано: ${form.get("transport_id")}; причина: ${form.get("context_reason")}`; };
createRoot(document.getElementById("root")!).render(<>
  <SourceTransportContext shipmentId="synthetic" extractionId="source" shipmentLabel="Импорт · SYNTH-01" transportId={null}
    vehicles={vehicles} editable history={[]} historyUnavailable={false} action={action}/>
  <SourceTransportContext shipmentId="synthetic-export" extractionId="confirmed" shipmentLabel="Экспорт · SYNTH-02" transportId="B"
    vehicles={vehicles} editable={false} history={[{ id: "change", old_transport_id: "A", new_transport_id: "B", reason: "Уточнение по синтетической CMR",
      changed_by: "Синтетический сотрудник", changed_at: "2026-10-20T10:00:00Z" }]} historyUnavailable={false} action={action}/>
  <p id="result"/>
</>);
