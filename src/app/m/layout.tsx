import type { Metadata, Viewport } from "next";
import Link from "next/link";

// The mobile warehouse (202611280500): one column, large buttons, no side menu, no horizontal scroll. Without a
// connection nothing works and nothing is queued (owner decision В2): the browser shows its own error.
export const metadata: Metadata = { title: "Nexus · Склад", appleWebApp: { capable: true, title: "Nexus Склад", statusBarStyle: "default" } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#009B77" };

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return <div className="mobile-shell">
    <header className="mobile-header"><Link href="/m" className="mobile-brand">Nexus · Склад</Link><Link href="/" className="mobile-desktop">Полная версия</Link></header>
    <main className="mobile-main">{children}</main>
    <p className="mobile-offline">Работа без связи не поддерживается: если сеть пропала, действие не выполнится и не встанет в очередь — повторите его, когда связь вернётся.</p>
  </div>;
}
