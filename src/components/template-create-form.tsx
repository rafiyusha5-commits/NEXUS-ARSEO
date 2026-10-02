"use client";

import { useMemo, useState } from "react";
import { TEMPLATE_DIRECTIONS, TEMPLATE_LANGUAGES, templateLanguageLabel } from "@/lib/templates/rules.ts";

type DocumentType = { id: string; name_ru: string; is_active: boolean };
type Party = { id: string; legal_name: string; short_name: string | null; roles: string[] };

export function TemplateCreateForm({
  action,
  types,
  parties,
  accept,
  fileTypesLabel,
  maxFileSizeLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  types: DocumentType[];
  parties: Party[];
  accept: string;
  fileTypesLabel: string;
  maxFileSizeLabel: string;
}) {
  const [direction, setDirection] = useState<(typeof TEMPLATE_DIRECTIONS)[number]>("input");
  const [counterpartyId, setCounterpartyId] = useState("");
  const matchingParties = useMemo(
    () => parties.filter((party) => direction === "input"
      ? party.roles.some((role) => role === "manufacturer" || role === "supplier")
      : party.roles.includes("customer")),
    [direction, parties],
  );

  return (
    <form action={action} className="doc-form">
      <label>Тип документа<select name="document_type_id" required defaultValue="">
        <option value="" disabled>Выберите тип</option>
        {types.filter((type) => type.is_active).map((type) => <option value={type.id} key={type.id}>{type.name_ru}</option>)}
      </select></label>
      <label>Где применяется<select name="flow_direction" required value={direction} onChange={(event) => {
        setDirection(event.target.value as (typeof TEMPLATE_DIRECTIONS)[number]);
        setCounterpartyId("");
      }}>
        <option value="input">Поставка / перевозка</option>
        <option value="output">Покупатель / карта ввода</option>
      </select></label>
      <label className="doc-form-wide">Название образца<input name="name" required maxLength={200} placeholder={direction === "input" ? "Например: CMR для экспортной перевозки" : "Например: карта ввода новинок Metro"} /></label>
      <label>Язык<select name="language" required defaultValue="ru">
        {TEMPLATE_LANGUAGES.map((code) => <option value={code} key={code}>{templateLanguageLabel[code]}</option>)}
      </select></label>
      <label className="doc-form-wide">Правило применения<input name="purpose" maxLength={1000} placeholder="Когда система должна использовать этот образец" /></label>
      <label className="doc-form-wide">{direction === "input" ? "Поставщик" : "Покупатель"}<select name="counterparty_id" value={counterpartyId} onChange={(event) => setCounterpartyId(event.target.value)}>
        <option value="">Общий шаблон для направления</option>
        {matchingParties.map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
      </select></label>
      <label className="doc-form-full">Изменяемые поля — по одному в строке, «ключ — описание»
        <textarea name="variables" rows={3} placeholder={"product_name — Наименование товара\ngtin — GTIN"} />
      </label>
      <label className="doc-form-wide doc-file">Готовый документ-образец<input name="file" type="file" required accept={accept} /></label>
      <button className="primary" type="submit">Сохранить образец</button>
      <p className="form-help doc-form-full">
        {fileTypesLabel}, до {maxFileSizeLabel}. Исходный файл хранится неизменным в закрытом хранилище. Система создаёт по нему отдельные заполненные документы после утверждения образца.
      </p>
    </form>
  );
}
