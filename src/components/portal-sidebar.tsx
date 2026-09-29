import Link from "next/link";
import { logout } from "@/app/login/actions";
import type { AccessProfile } from "@/lib/auth/access";

export function PortalSidebar({ profile, active }: { profile: AccessProfile; active: "documents" | "profile" }) {
  return (
    <aside className="sidebar portal-sidebar">
      <Link className="brand" href="/portal/documents">
        <span className="brand-mark">N</span><span><strong>Nexus</strong><small>КАБИНЕТ КЛИЕНТА</small></span>
      </Link>
      <nav className="sidebar-nav" aria-label="Кабинет клиента">
        <Link className={active === "documents" ? "active" : ""} href="/portal/documents">Документы</Link>
        <Link className={active === "profile" ? "active" : ""} href="/portal/profile">Профиль</Link>
      </nav>
      <div className="profile">
        <span>{profile.full_name.slice(0, 2).toUpperCase()}</span>
        <div className="profile-copy"><strong>{profile.full_name}</strong><small>Представитель клиента</small></div>
        <form action={logout}><button className="profile-logout" type="submit" title="Выйти">↪</button></form>
      </div>
    </aside>
  );
}
