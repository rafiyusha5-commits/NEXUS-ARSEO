import { createRoot } from "react-dom/client";
import { ProcessingStatus } from "../../src/components/documents/processing-status";
const common = { kind: "import", stage: "registering", started_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:10Z", lease_until: "2030-01-01T00:02:00Z", finished_at: null, error_code: null };
createRoot(document.getElementById("root")!).render(<ProcessingStatus serverNow={Date.parse("2030-01-01T00:03:00Z")} receipts={[
  { ...common, id: "synthetic-interrupted", state: "running" },
  { ...common, id: "synthetic-completed", state: "completed", stage: "finished", finished_at: "2030-01-01T00:00:10Z" },
  { ...common, id: "synthetic-uncertain", state: "needs_action", error_code: "SAVE_UNCERTAIN" },
]}/>);
