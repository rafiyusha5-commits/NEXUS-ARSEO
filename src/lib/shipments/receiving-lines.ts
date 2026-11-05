const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ["item_id", "expected_quantity", "accepted_quantity", "damaged_quantity", "batch_number", "manufacture_date", "expiry_date", "discrepancy_reason"] as const;

export function readReceivingLines(form: FormData) {
  const values = Object.fromEntries(fields.map(key => [key, form.getAll(key).map(value => typeof value === "string" ? value.trim() : "")])) as Record<typeof fields[number], string[]>;
  if (!values.item_id.length || values.item_id.length > 2000 || fields.some(key => values[key].length !== values.item_id.length)) {
    throw new Error("Позиции и партии приёмки переданы не полностью");
  }
  const quantity = (value: string, positive: boolean) => {
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error("Укажите количество числом, не более трёх знаков после запятой");
    const number = Number(value);
    if (!Number.isFinite(number) || number > 99999999999.999 || (positive ? number <= 0 : number < 0)) throw new Error("Проверьте количество партии");
    return number;
  };
  const day = (value: string) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Некорректная дата партии");
    return value;
  };
  return values.item_id.map((id, index) => {
    if (!uuidPattern.test(id)) throw new Error("Некорректная позиция приёмки");
    return { item_id: id, expected_quantity: quantity(values.expected_quantity[index], true),
      accepted_quantity: quantity(values.accepted_quantity[index], false), damaged_quantity: quantity(values.damaged_quantity[index], false),
      batch_number: values.batch_number[index] || null, manufacture_date: day(values.manufacture_date[index]),
      expiry_date: day(values.expiry_date[index]), discrepancy_reason: values.discrepancy_reason[index] || null };
  });
}
