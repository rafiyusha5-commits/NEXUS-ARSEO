"use client";

import { useState } from "react";
import { cardTypeLabel } from "@/lib/listing-cards/rules.ts";

type Party = { id: string; legal_name: string; short_name: string | null; roles: string[] };
type Template = { id: string; name: string; language: string; flow_direction: string; counterparty_id: string | null };

export function ListingCardEditForm({
  action,
  card,
  parties,
  templates,
}: {
  action: (formData: FormData) => void | Promise<void>;
  card: {
    id: string;
    card_type: string;
    counterparty_id: string;
    template_id: string | null;
    effective_date: string | null;
    title: string | null;
    notes: string | null;
  };
  parties: Party[];
  templates: Template[];
}) {
  const [counterpartyId, setCounterpartyId] = useState(card.counterparty_id);
  const [templateId, setTemplateId] = useState(card.template_id ?? "");
  const matchingParties = parties.filter((party) => card.card_type === "input"
    ? party.roles.some((role) => role === "manufacturer" || role === "supplier")
    : party.roles.includes("customer"));
  const matchingTemplates = templates.filter((template) => template.flow_direction === card.card_type
    && (template.counterparty_id === null || template.counterparty_id === counterpartyId));

  return (
    <form action={action} className="doc-form">
      <input type="hidden" name="card_id" value={card.id} />
      <input type="hidden" name="card_type" value={card.card_type} />
      <label>Направление<input value={cardTypeLabel[card.card_type]} readOnly /></label>
      <label className="doc-form-wide">{card.card_type === "input" ? "Поставщик" : "Покупатель"}<select
        name="counterparty_id"
        required
        value={counterpartyId}
        onChange={(event) => {
          setCounterpartyId(event.target.value);
          setTemplateId("");
        }}
      >
        {matchingParties.map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
      </select></label>
      <label>Вступает в силу<input name="effective_date" type="date" defaultValue={card.effective_date ?? ""} /></label>
      <label className="doc-form-wide">Название<input name="title" maxLength={200} defaultValue={card.title ?? ""} /></label>
      <label className="doc-form-wide">Подходящий шаблон<select
        name="template_id"
        value={templateId}
        onChange={(event) => setTemplateId(event.target.value)}
      >
        <option value="">Без шаблона</option>
        {matchingTemplates.map((template) => <option value={template.id} key={template.id}>{template.name} ({template.language})</option>)}
      </select></label>
      <label className="doc-form-rest">Примечание<textarea name="notes" maxLength={2000} rows={2} defaultValue={card.notes ?? ""} /></label>
      <button className="primary" type="submit">Сохранить</button>
    </form>
  );
}
