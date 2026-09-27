"use client";

import { useMemo, useState } from "react";
import { TEMPLATE_DIRECTIONS, TEMPLATE_LANGUAGES, templateDirectionLabel, templateLanguageLabel } from "@/lib/templates/rules.ts";

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
      <label>Направление<select name="flow_direction" required value={direction} onChange={(event) => {
        setDirection(event.target.value as (typeof TEMPLATE_DIRECTIONS)[number]);
        setCounterpartyId("");
      }}>
        {TEMPLATE_DIRECTIONS.map((item) => <option value={item} key={item}>{templateDirectionLabel[item]}</option>)}
      </select></label>
      <label className="doc-form-wide">Название<input name="name" required maxLength={200} placeholder={direction === "input" ? "Например: форма поставщика для заказа" : "Например: листинг-карта покупателя"} /></label>
      <label>Язык<select name="language" required defaultValue="ru">
        {TEMPLATE_LANGUAGES.map((code) => <option value={code} key={code}>{templateLanguageLabel[code]}</option>)}
      </select></label>
      <label className="doc-form-wide">Назначение<input name="purpose" maxLength={1000} placeholder="Для чего и когда используется шаблон" /></label>
      <label className="doc-form-wide">{direction === "input" ? "Поставщик" : "Покупатель"}<select name="counterparty_id" value={counterpartyId} onChange={(event) => setCounterpartyId(event.target.value)}>
        <option value="">Общий шаблон для направления</option>
        {matchingParties.map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
      </select></label>
      <label className="doc-form-full">Поля для подстановки — по одному в строке, «ключ — описание»
        <textarea name="variables" rows={3} placeholder={"product_name — Наименование товара\ngtin — GTIN"} />
      </label>
      <label className="doc-form-wide doc-file">Файл шаблона<input name="file" type="file" required accept={accept} /></label>
      <button className="primary" type="submit">Создать шаблон</button>
      <p className="form-help doc-form-full">
        {fileTypesLabel}, до {maxFileSizeLabel}. Файл хранится в закрытом хранилище. Новый шаблон создаётся черновиком и используется после утверждения.
      </p>
    </form>
  );
}
