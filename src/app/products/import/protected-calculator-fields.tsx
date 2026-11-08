import type { CalculatorProtectedField } from "@/lib/reference-import/report.ts";

export function ProtectedCalculatorFields({ fields }: { fields: CalculatorProtectedField[] }) {
  if (!fields.length) return null;
  return <section aria-label="Сохранённые значения карточек">
    <h3>Сохраняем значения Nexus</h3>
    <p>Калькулятор содержит другие сроки годности или коды ТН ВЭД. Заполненные значения карточек
      сохраняются. Исходные значения калькулятора доступны отдельно; для изменения карточки нужна ручная проверка.</p>
    <div className="import-table-wrap">
      <table className="import-table">
        <thead><tr><th>Артикул</th><th>Поле</th><th>Остаётся в Nexus</th><th>В калькуляторе</th></tr></thead>
        <tbody>{fields.map((item, index) => <tr key={`${item.sku}-${item.field}-${index}`}>
          <td>{item.sku}</td><td>{item.field === "shelf_life_days" ? "Срок годности, дни" : "ТН ВЭД"}</td>
          <td>{item.nexusValue}</td><td>{item.sourceValue}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
