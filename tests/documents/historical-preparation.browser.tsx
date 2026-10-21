import { createRoot } from "react-dom/client";
import { HistoricalPreparation } from "../../src/components/documents/historical-preparation";
import { preparationFixture } from "../fixtures/historical-preparation";
const kind = new URL(location.href).searchParams.get("set") as "complete" | "incomplete" | "conflicting";
const action = async () => { document.getElementById("result")!.textContent = "Synthetic save requested"; };
createRoot(document.getElementById("root")!).render(<><HistoricalPreparation input={preparationFixture(kind)} id="synthetic-draft" revision={0} prepareNew={false} save={action}/><p id="result"/></>);
