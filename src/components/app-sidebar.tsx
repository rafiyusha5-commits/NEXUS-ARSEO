import Link from "next/link";
import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import type { AccessProfile, AccessRole } from "@/lib/auth/access";
import { roleLabel } from "@/lib/auth/access";
import { BrandLockup } from "./brand";
import { MenuIcon, NavIcon } from "./nav-icons";
import { NotificationsBadge } from "./notifications-badge";

type NavigationItem = { label: string; href: string; key: string; managerOnly?: boolean };

const navigationGroups: { label: string; items: NavigationItem[] }[] = [
  { label: "Главная", items: [
    { label: "Обзор", href: "/", key: "overview" },
    { label: "Задачи", href: "/tasks", key: "tasks" },
    { label: "Уведомления", href: "/notifications", key: "notifications" },
    { label: "Ассистент", href: "/assistant", key: "assistant" },
  ] },
  { label: "Закупки", items: [
    { label: "Поступления и поставки", href: "/shipments", key: "shipments" },
    { label: "План закупок", href: "/purchase-plans", key: "purchase-plans" },
    { label: "Автозаказ Казахстан", href: "/replenishment", key: "replenishment" },
  ] },
  { label: "Продажи", items: [
    { label: "Заказы покупателей", href: "/sales", key: "sales" },
    { label: "Возвраты", href: "/sales/returns", key: "customer-returns" },
    { label: "Промо и спецзаказы", href: "/commercial-programs", key: "commercial-programs" },
    { label: "Карты ввода товаров", href: "/listing-cards", key: "listing-cards" },
  ] },
  { label: "Логистика", items: [
    { label: "Логист", href: "/logist", key: "logist" },
    { label: "Перевозчики и рейсы", href: "/freight", key: "freight" },
    { label: "Календарь перевозок", href: "/calendar", key: "calendar" },
    { label: "Маршруты", href: "/routes", key: "routes" },
  ] },
  { label: "Склад", items: [
    { label: "Остатки и партии", href: "/inventory", key: "inventory" },
    { label: "Перемещения и списания", href: "/inventory/movements", key: "inventory-movements" },
    { label: "Контроль ОСГ", href: "/inventory/shelf-life", key: "shelf-life" },
    { label: "Склады и зоны", href: "/warehouses", key: "warehouses" },
    { label: "Стикеры и маркировка", href: "/stickers", key: "stickers" },
  ] },
  { label: "Справочники", items: [
    { label: "Покупатели", href: "/counterparties", key: "counterparties" },
    { label: "Поставщики", href: "/suppliers", key: "suppliers" },
    { label: "Товары", href: "/products", key: "products" },
  ] },
  { label: "Финансы", items: [
    { label: "Расходы и себестоимость", href: "/finance", key: "finance" },
    { label: "Дебиторка", href: "/finance/receivables", key: "receivables" },
    { label: "Поступления из банка", href: "/finance/bank", key: "bank" },
  ] },
  { label: "Документы", items: [
    { label: "Журнал документов", href: "/documents", key: "documents" },
    { label: "Библиотека образцов", href: "/templates", key: "templates" },
  ] },
  { label: "Планирование", items: [
    { label: "Прогноз продаж", href: "/forecasts", key: "forecasts" },
    { label: "Аналитика", href: "/analytics", key: "analytics" },
  ] },
  { label: "Администрирование", items: [
    { label: "Сотрудники", href: "/admin/users", key: "users", managerOnly: true },
    { label: "Доступ клиентов", href: "/admin/client-access", key: "client-access", managerOnly: true },
    { label: "Роли и права", href: "/admin/roles", key: "roles", managerOnly: true },
    { label: "Интеграции", href: "/integrations", key: "integrations", managerOnly: true },
    { label: "Архив учебных проектов", href: "/admin/archive", key: "operational-archive", managerOnly: true },
    { label: "Журнал действий", href: "/audit", key: "audit", managerOnly: true },
  ] },
];

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("ru-RU"))
    .join("");
}

export function AppSidebar({
  profile,
  roles,
  active,
}: {
  profile: AccessProfile;
  roles: AccessRole[];
  active: string;
}) {
  const isManager = roles.some((role) =>
    ["administrator", "director"].includes(role.code),
  );

  return (
    <aside className="sidebar">
      {/* Phones: the menu folds into a panel opened by this checkbox; no client script needed. */}
      <input className="sidebar-toggle-input" type="checkbox" id="sidebar-toggle" aria-label="Показать меню" />
      <div className="sidebar-head">
        <Link className="brand" href="/" aria-label="Nexus ARSEO — на главную">
          <BrandLockup />
        </Link>
        <label className="sidebar-toggle" htmlFor="sidebar-toggle"><MenuIcon /><span>Меню</span></label>
      </div>
      <div className="sidebar-body">
        <nav className="sidebar-nav" aria-label="Основная навигация">
          {navigationGroups.map((group) => {
            const items = group.items.filter((item) => !item.managerOnly || isManager);
            if (!items.length) return null;
            const containsActive = items.some((item) => item.key === active);
            return <details className="sidebar-group" open={containsActive || group.label === "Главная"} key={group.label}>
              <summary><span className="sidebar-group-label"><NavIcon group={group.label} />{group.label}</span><span className="sidebar-chevron" aria-hidden="true">⌄</span></summary>
              <div className="sidebar-group-links">
                {items.map((item) => (
                  <Link className={item.key === active ? "active" : ""} aria-current={item.key === active ? "page" : undefined} href={item.href} key={item.key}>
                    {item.label}
                    {item.key === "notifications" && (
                      <Suspense fallback={null}>
                        <NotificationsBadge />
                      </Suspense>
                    )}
                  </Link>
                ))}
              </div>
            </details>;
          })}
        </nav>
        <div className="profile">
          <span>{initials(profile.full_name) || "AR"}</span>
          <div className="profile-copy">
            <strong>{profile.full_name}</strong>
            <small>{roleLabel(roles, profile.job_title)}</small>
          </div>
          <form action={logout}>
            <button className="profile-logout" type="submit" title="Выйти" aria-label="Выйти из системы">↪</button>
          </form>
        </div>
      </div>
    </aside>
  );
}
