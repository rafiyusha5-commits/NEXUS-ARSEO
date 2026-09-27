"use client";

import { useMemo, useState } from "react";
import { CARD_TYPES, cardTypeLabel } from "@/lib/listing-cards/rules.ts";

type Party = { id: string; legal_name: string; short_name: string | null; roles: string[] };
type Template = { id: string; name: string; language: string; flow_direction: string; counterparty_id: string | null };

export function ListingCardCreateForm({
  action,
  parties,
  templates,
}: {
  action: (formData: FormData) => void | Promise<void>;
  parties: Party[];
  templates: Template[];
}) {
  const [direction, setDirection] = useState<(typeof CARD_TYPES)[number]>("input");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const matchingParties = useMemo(
    () => parties.filter((party) => direction === "input"
      ? party.roles.some((role) => role === "manufacturer" || role === "supplier")
      : party.roles.includes("customer")),
    [direction, parties],
  );
  const matchingTemplates = templates.filter(
    (template) => template.flow_direction === direction
      && (template.counterparty_id === null || template.counterparty_id === counterpartyId),
  );

  return (
    <form action={action} className="doc-form">
      <label>Направление<select
        name="card_type"
        required
        value={direction}
        onChange={(event) => {
          setDirection(event.target.value as (typeof CARD_TYPES)[number]);
          setCounterpartyId("");
          setTemplateId("");
        }}
      >
        {CARD_TYPES.map((type) => <option value={type} key={type}>{cardTypeLabel[type]}</option>)}
      </select></label>
      <label className="doc-form-wide">{direction === "input" ? "Поставщик" : "Покупатель"}<select
        name="counterparty_id"
        required
        value={counterpartyId}
        onChange={(event) => {
          setCounterpartyId(event.target.value);
          setTemplateId("");
        }}
      >
        <option value="" disabled>{direction === "input" ? "Выберите поставщика" : "Выберите покупателя"}</option>
        {matchingParties.map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
      </select></label>
      <label>Вступает в силу<input name="effective_date" type="date" /></label>
      <label className="doc-form-wide">Название<input name="title" maxLength={200} placeholder={direction === "input" ? "Например: данные поставщика по новинкам" : "Например: листинг новинок для сети"} /></label>
      <label className="doc-form-wide">Подходящий шаблон<select name="template_id" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
        <option value="">Без шаблона</option>
        {matchingTemplates.map((template) => <option value={template.id} key={template.id}>{template.name} ({template.language})</option>)}
      </select></label>
      <label className="doc-form-rest">Примечание<textarea name="notes" maxLength={2000} rows={2} /></label>
      <button className="primary" type="submit" disabled={!counterpartyId}>Создать черновик</button>
      {!matchingParties.length && <p className="form-help doc-form-full">Для этого направления нет активных контрагентов с нужной ролью.</p>}
      <p className="form-help doc-form-full">Список шаблонов автоматически ограничен выбранным направлением и контрагентом.</p>
    </form>
  );
}
