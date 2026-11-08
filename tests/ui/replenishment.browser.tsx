import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReplenishmentWorkspace } from "../../src/components/replenishment-workspace";
import { fixture } from "../replenishment/fixture";
import type { Workspace } from "../../src/lib/replenishment/workspace";
const snapshot = fixture();
const profile = { id: "a8000000-0000-4000-8000-000000000001", supplier_id: "S", name: "Синтетический поставщик", settings: snapshot.settings, reason: "Проверка", created_at: "2026-11-08T08:00:00Z" };
function Example() {
  const [mode, setMode] = useState("ready"), [payload, setPayload] = useState("");
  const data = structuredClone(snapshot);
  if (mode === "unknown") data.settings.overrides = [];
  const workspace: Workspace = { profile, profiles: [profile], snapshot: data, sources: [], purposes: [], warehouses: [{ id: "ACT", name: "Актобе" }, { id: "AST", name: "Астана" }, { id: "ALA", name: "Алматы" }], suppliers: [{ id: "S", name: "Синтетический поставщик" }], runs: [], decisions: [], fresh: mode !== "stale" };
  const action = async (form: FormData) => { setPayload(JSON.stringify(Object.fromEntries(form))); };
  return <main className="workspace admin-workspace replenishment-workspace" style={{ margin: 0, width: "100%" }}><label>Сценарий<select value={mode} onChange={e => setMode(e.target.value)}><option value="ready">Готово</option><option value="unknown">Нет истории</option><option value="stale">Устарело</option></select></label><ReplenishmentWorkspace workspace={workspace} runId={profile.id} requestId={profile.id} actions={{ createProfile: action, capture: action, setPurpose: action, prepareDraft: action }}/><output id="payload" style={{ overflowWrap: "anywhere" }}>{payload}</output></main>;
}
createRoot(document.getElementById("root")!).render(<Example/>);
