"use client";

import { useMemo, useState } from "react";

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
  const [counterpartyId, setCounterpartyId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const matchingParties = useMemo(
    () => parties.filter((party) => party.roles.includes("customer")),
    [parties],
  );
  const matchingTemplates = templates.filter(
    (template) => template.flow_direction === "output"
      && (template.counterparty_id === null || template.counterparty_id === counterpartyId),
  );

  return (
    <form action={action} className="doc-form">
      <input type="hidden" name="card_type" value="output" />
      <label>Назначение<input value="Ввод нового товара в ассортимент покупателя" readOnly /></label>
      <label className="doc-form-wide">Покупатель<select
        name="counterparty_id"
        required
        value={counterpartyId}
        onChange={(event) => {
          setCounterpartyId(event.target.value);
          setTemplateId("");
        }}
      >
        <option value="" disabled>Выберите покупателя</option>
        {matchingParties.map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
      </select></label>
      <label>Вступает в силу<input name="effective_date" type="date" /></label>
      <label className="doc-form-wide">Название<input name="title" maxLength={200} placeholder="Например: новинки Fazer для сети Metro" /></label>
      <label className="doc-form-wide">Образец формы покупателя<select name="template_id" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
        <option value="">Без привязанного образца</option>
        {matchingTemplates.map((template) => <option value={template.id} key={template.id}>{template.name} ({template.language})</option>)}
      </select></label>
      <label className="doc-form-rest">Примечание<textarea name="notes" maxLength={2000} rows={2} /></label>
      <button className="primary" type="submit" disabled={!counterpartyId}>Создать черновик</button>
      {!matchingParties.length && <p className="form-help doc-form-full">Нет активных покупателей. Сначала добавьте покупателя в справочник.</p>}
      <p className="form-help doc-form-full">Карта нужна для передачи покупателю данных о новинке и её ввода в его ассортимент. Подходящие образцы ограничены выбранным покупателем.</p>
    </form>
  );
}
