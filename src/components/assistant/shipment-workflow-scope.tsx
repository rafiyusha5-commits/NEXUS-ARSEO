"use client";

import type { ReactNode } from "react";

/** Adds navigation context only. Native server actions keep all authorization and confirmations. */
export function ShipmentWorkflowScope({ shipmentId, children }: { shipmentId: string; children: ReactNode }) {
  return <div onSubmitCapture={event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || new FormData(form).get("shipment_id") !== shipmentId) return;
    let field = form.querySelector<HTMLInputElement>('input[name="assistant_workflow"]');
    if (!field) { field = document.createElement("input"); field.type = "hidden"; field.name = "assistant_workflow"; form.appendChild(field); }
    field.value = "1";
  }}>{children}</div>;
}
