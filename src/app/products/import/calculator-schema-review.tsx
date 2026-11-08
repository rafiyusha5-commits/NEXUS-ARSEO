"use client";

import { useState } from "react";
import type { CalculatorSchemaReview, SchemaColumn } from "@/lib/calculator-import/schema-review.ts";

const access = { catalog: "Каталог", sales: "Продажи", confidential: "Только с правом на закупочные цены и себестоимость" };
export function CalculatorSchemaReviewPanel({ review, pending, onConfirm }: {
  review: CalculatorSchemaReview; pending: boolean; onConfirm: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const rows: { kind: string; before?: SchemaColumn; after?: SchemaColumn }[] = [
    ...review.added.map(after => ({ kind: "Добавлен", after })),
    ...review.removed.map(before => ({ kind: "Удалён", before })),
    ...review.changed.map(change => ({ kind: "Изменён", ...change })),
  ];
  return <div>
    <h3>Изменилась структура калькулятора</h3>
    <p>Было столбцов: {review.current_count}. Сейчас: {review.incoming_count}. Товары и цены ещё не изменены.</p>
    <ul className="calculator-schema-changes">
      {rows.map(({ kind, before, after }) => {
        const column = after ?? before;
        if (!column) return null;
        return <li key={column.key}>
          <strong>{kind}: {before && after ? `${before.field_ru} → ${after.field_ru}` : column.field_ru}</strong>
          <p>Блок: {before && after && before.block !== after.block ? `${before.block ?? "—"} → ${after.block ?? "—"}` : column.block ?? "—"}</p>
          <p>Доступ: {before && after && before.visibility !== after.visibility ? `${access[before.visibility]} → ${access[after.visibility]}` : access[column.visibility]}</p>
        </li>;
      })}
    </ul>
    {review.status === "approval_required" ? <>
      <p>Можно подтвердить только добавленные столбцы цен. Подтверждение сохранит структуру и автора в истории Nexus, затем начнётся проверка товаров без записи. Google Таблица не изменится.</p>
      <label className="form-help"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} /> Я проверила новые столбцы и указанный доступ</label>
      <div className="import-confirm"><button type="button" className="primary" disabled={pending || !confirmed} onClick={onConfirm}>
        {pending ? "Проверка…" : "Подтвердить новые столбцы и проверить"}
      </button></div>
    </> : <p className="login-error admin-message">Изменение названий, удаление столбцов или изменение доступа требует проверки разработчиком. Синхронизация остановлена; существующие данные сохранены.</p>}
  </div>;
}
