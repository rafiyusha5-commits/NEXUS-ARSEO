// Notification labels and links. Notifications are created by the database (migration
// 202609272200); the page only renders them.

export const notificationTypeLabel: Record<string, string> = {
  task_assigned: "Назначена задача",
  task_reassigned: "Переназначение задачи",
  deadline: "Приближается срок",
  overdue: "Просрочка",
  stage_blocked: "Этап заблокирован",
  order_blocked: "Заказ нельзя отгрузить",
  price_review: "Проверьте цену",
  drive_new_files: "Новые файлы в папке Drive",
  cash_gap: "Кассовый разрыв",
  approval_request: "Запрос согласования",
  approval_decision: "Согласование завершено",
  status_change: "Изменение статуса",
  discrepancy: "Расхождение",
  low_shelf_life: "Остаточный срок годности",
  document_uploaded: "Документ загружен",
  sync_error: "Ошибка синхронизации",
  system: "Системное",
};

// Types that need attention get a warning colour.
export const URGENT_NOTIFICATION_TYPES = new Set(["overdue", "stage_blocked", "approval_request", "order_blocked", "cash_gap"]);

export type NotificationTarget = { entity_type: string | null; entity_id: string | null; shipment_id: string | null };
export type NotificationLink = { href: string; label: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Link to the task, stage, shipment or approved object. Only ids go into the URL, so a
// notification can never point outside the application.
export function notificationLink(target: NotificationTarget): NotificationLink | null {
  if (target.entity_type === "system_health") return { href: "/admin/health", label: "Открыть состояние системы" };
  const entity = target.entity_id && UUID.test(target.entity_id) ? target.entity_id : null;
  const shipment = target.shipment_id && UUID.test(target.shipment_id) ? target.shipment_id : null;
  if (entity) {
    switch (target.entity_type) {
      case "task":
        return { href: `/tasks?task=${entity}`, label: "Открыть задачу" };
      case "shipment_stage_run":
        if (shipment) return { href: `/shipments/${shipment}#stage-${entity}`, label: "Открыть этап" };
        break;
      case "shipment":
        return { href: `/shipments/${entity}`, label: "Открыть поставку" };
      case "shipment_document_check":
        return { href: `/shipments/${entity}?tab=documents#document-check`, label: "Открыть «Сверку»" };
      case "document":
        return { href: `/documents/${entity}`, label: "Открыть документ" };
      case "sale":
        return { href: `/sales/${entity}?tab=shipping`, label: "Открыть заказ" };
      case "price_review":
        return { href: `/sales/prices?tab=list&product=${entity}`, label: "Открыть прайс товара" };
      case "shipment_drive_folder":
        return { href: `/shipments/${entity}?tab=documents#drive-folder`, label: "Открыть папку поставки" };
    }
  }
  // The daily summary of the «Контроль ОСГ» agent points to its screen, not to one object.
  if (target.entity_type === "shelf_life_control") return { href: "/inventory/shelf-life", label: "Открыть «Контроль ОСГ»" };
  // A cash gap points to the payment calendar (202611280200), not to one object.
  if (target.entity_type === "cash_calendar") return { href: "/finance/cash", label: "Открыть платёжный календарь" };
  return shipment ? { href: `/shipments/${shipment}`, label: "Открыть поставку" } : null;
}

export function unreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}
