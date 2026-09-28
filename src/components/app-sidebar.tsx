import Link from "next/link";
import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import type { AccessProfile, AccessRole } from "@/lib/auth/access";
import { roleLabel } from "@/lib/auth/access";
import { NotificationsBadge } from "./notifications-badge";

const navigation = [
  { label: "Обзор", href: "/", key: "overview" },
  { label: "Задачи", href: "/tasks", key: "tasks" },
  { label: "Уведомления", href: "/notifications", key: "notifications" },
  { label: "Поставки", href: "/shipments", key: "shipments" },
  { label: "Клиентские заказы", href: "/sales", key: "sales" },
  { label: "Клиенты", href: "/counterparties", key: "counterparties" },
  { label: "Поставщики", href: "/suppliers", key: "suppliers" },
  { label: "Товары", href: "/products", key: "products" },
  { label: "Склады", href: "/warehouses", key: "warehouses" },
  { label: "Остатки FIFO", href: "/inventory", key: "inventory" },
  { label: "Движения", href: "/inventory/movements", key: "inventory-movements" },
  { label: "Маршруты", href: "/routes", key: "routes" },
  { label: "Документы", href: "/documents", key: "documents" },
  { label: "Шаблоны", href: "/templates", key: "templates" },
  { label: "Карты ввода/вывода", href: "/listing-cards", key: "listing-cards" },
  { label: "Стикеры и маркировка", href: "/stickers", key: "stickers" },
  { label: "Пользователи", href: "/admin/users", key: "users", managerOnly: true },
  { label: "Роли и права", href: "/admin/roles", key: "roles", managerOnly: true },
  { label: "Журнал действий", href: "/audit", key: "audit", managerOnly: true },
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
      <Link className="brand" href="/">
        <span className="brand-mark">N</span>
        <span><strong>Nexus</strong><small>ARSEO</small></span>
      </Link>
      <nav className="sidebar-nav" aria-label="Основная навигация">
        {navigation
          .filter((item) => !item.managerOnly || isManager)
          .map((item) => (
            <Link className={item.key === active ? "active" : ""} href={item.href} key={item.key}>
              {item.label}
              {item.key === "notifications" && (
                <Suspense fallback={null}>
                  <NotificationsBadge />
                </Suspense>
              )}
            </Link>
          ))}
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
    </aside>
  );
}
