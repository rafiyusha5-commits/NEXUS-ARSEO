import Link from "next/link";
import { logout } from "@/app/login/actions";
import type { AccessProfile } from "@/lib/auth/access";
import { BrandLockup } from "./brand";
import { MenuIcon } from "./nav-icons";

export function PortalSidebar({ profile, active }: { profile: AccessProfile; active: "documents" | "profile" }) {
  return (
    <aside className="sidebar portal-sidebar">
      <input className="sidebar-toggle-input" type="checkbox" id="sidebar-toggle" aria-label="Показать меню" />
      <div className="sidebar-head">
        <Link className="brand" href="/portal/documents" aria-label="Кабинет клиента ARSEO">
          <BrandLockup subtitle="Кабинет клиента" />
        </Link>
        <label className="sidebar-toggle" htmlFor="sidebar-toggle"><MenuIcon /><span>Меню</span></label>
      </div>
      <div className="sidebar-body">
        <nav className="sidebar-nav" aria-label="Кабинет клиента">
          <Link className={active === "documents" ? "active" : ""} aria-current={active === "documents" ? "page" : undefined} href="/portal/documents">Документы</Link>
          <Link className={active === "profile" ? "active" : ""} aria-current={active === "profile" ? "page" : undefined} href="/portal/profile">Профиль</Link>
        </nav>
        <div className="profile">
          <span>{profile.full_name.slice(0, 2).toUpperCase()}</span>
          <div className="profile-copy"><strong>{profile.full_name}</strong><small>Представитель клиента</small></div>
          <form action={logout}><button className="profile-logout" type="submit" title="Выйти" aria-label="Выйти из кабинета">↪</button></form>
        </div>
      </div>
    </aside>
  );
}
