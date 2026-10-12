// Russian labels for status codes the tools return. Code-rendered values use these labels, and
// fact checking compares status words in the model's text against them.

export const shipmentStatusLabel: Record<string, string> = {
  planning: "Планирование", in_production: "У производителя", preparing_transport: "Подготовка перевозки",
  in_transit: "В пути", customs: "Таможня", receiving: "Приёмка", sales: "Реализация", closed: "Закрыта",
  on_hold: "Приостановлена", cancelled: "Отменена",
};

export const shipmentTypeLabel: Record<string, string> = { import: "Импорт", export: "Экспорт", domestic_transfer: "Внутреннее перемещение" };

export const vehicleStatusLabel: Record<string, string> = {
  planned: "Запланирован", loading: "На загрузке", in_transit: "В пути", at_customs: "На таможне",
  arrived: "Прибыл", unloaded: "Разгружен", cancelled: "Отменён",
};

export const stageStatusLabel: Record<string, string> = {
  pending: "Ожидает", in_progress: "В работе", blocked: "Заблокирован", completed: "Завершён",
  skipped: "Пропущен", not_applicable: "Не требуется",
};

export const taskStatusLabel: Record<string, string> = { open: "Открыта", in_progress: "В работе", done: "Завершена", cancelled: "Отменена" };
export const taskPriorityLabel: Record<string, string> = { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" };

export const documentStatusLabel: Record<string, string> = { uploaded: "Загружен", under_review: "На проверке", approved: "Утверждён", rejected: "Отклонён" };

export const extractionStatusLabel: Record<string, string> = {
  pending: "Ожидает", extracted: "Распознан", needs_review: "Требует проверки", confirmed: "Подтверждён",
  failed: "Ошибка распознавания", superseded: "Заменён",
};

export const shelfLifeLabel: Record<string, string> = {
  normal: "Нормальный срок", warning: "До 90 дней", critical: "До 30 дней", expired: "Просрочен",
  quarantine: "Карантин", blocked: "Заблокирован",
};

export const ALL_STATUS_LABELS: Record<string, Record<string, string>> = {
  shipment: shipmentStatusLabel, vehicle: vehicleStatusLabel, stage: stageStatusLabel, task: taskStatusLabel,
  document: documentStatusLabel, extraction: extractionStatusLabel, shelf: shelfLifeLabel,
};

export function label(map: Record<string, string>, code: unknown): string | null {
  if (typeof code !== "string" || !code) return null;
  return map[code] ?? code;
}
