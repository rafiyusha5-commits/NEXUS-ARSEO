export function CustomsEvidence({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || !("fields" in value) || !Array.isArray(value.fields)) return null;
  const fields = value.fields.filter((field): field is { label: string; value: string } => Boolean(field && typeof field.label === "string" && typeof field.value === "string"));
  const warnings = "warnings" in value && Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [];
  return <div className="setup-notice">
    <h4>{"kind" in value && value.kind === "declaration" ? "Реквизиты таможенной декларации" : "Расчёт таможенных начислений"}</h4>
    <dl>{fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd><strong>{field.value}</strong></dd></div>)}</dl>
    {warnings.map((warning, index) => <p key={index}>{warning}</p>)}
    <p>Только результат чтения для сверки с оригиналом. Эти реквизиты не записываются автоматически в поставку, себестоимость или платежи.</p>
  </div>;
}
