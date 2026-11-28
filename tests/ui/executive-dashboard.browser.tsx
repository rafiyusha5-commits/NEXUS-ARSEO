import React from "react";
import { createRoot } from "react-dom/client";
import { ExecutiveTiles } from "../../src/components/executive-dashboard";
import { attention, type DashboardTile } from "../../src/lib/dashboard/executive";

// Synthetic tiles shaped as the tile function returns them; the shipments source "failed".
const base = { month: "2026-11-01", previous_month: "2026-10-01", status: "ok" as const };
export const tiles: DashboardTile[] = [
  { ...base, tile: "revenue", revenue_net: "48250000.00", profit: "9120000.00", complete_revenue: "45100000.00", margin_pct: "20.22",
    complete_share_pct: "93.47", lines: 412, incomplete_lines: 9, previous: { revenue_net: "43900000.00", profit: "8400000.00", margin_pct: "19.80" },
    incomplete: true, link: "/analytics/profitability?group=customer&from=2026-11-01&to=2026-11-30" },
  { ...base, tile: "receivables", currencies: [{ currency: "KZT", overdue: "6350000.00", kzt: "6350000.00" }, { currency: "EUR", overdue: "4200.00", kzt: "2100000.00" }],
    overdue_kzt: "8450000.00", customers: 7, incomplete: false, link: "/finance/receivables",
    top: [{ customer_id: "11111111-1111-4111-8111-111111111111", customer: "ТОО «Северный дистрибьютор»", kzt: "3100000.00", days: 41, amounts: [{ currency: "KZT", overdue: "3100000.00" }] },
      { customer_id: "22222222-2222-4222-8222-222222222222", customer: "Euro Retail GmbH", kzt: "2100000.00", days: 12, amounts: [{ currency: "EUR", overdue: "4200.00" }] },
      { customer_id: "33333333-3333-4333-8333-333333333333", customer: "ТОО «Восток Маркет»", kzt: "1450000.00", days: 8, amounts: [{ currency: "KZT", overdue: "1450000.00" }] }] },
  { ...base, tile: "payables", currencies: [{ currency: "KZT", overdue: "350000.00", due_14: "12800000.00", rest: "21400000.00", overdue_kzt: "350000.00", due_14_kzt: "12800000.00" },
    { currency: "EUR", overdue: "0", due_14: "18500.00", rest: "61000.00", overdue_kzt: "0.00", due_14_kzt: "9250000.00" }],
    overdue_kzt: "350000.00", due_14_kzt: "22050000.00", goods: true, incomplete: false, link: "/finance/payables" },
  { ...base, tile: "cash", currencies: [{ currency: "KZT", first_gap: null, first_gap_with_plan: "2027-01-18", opening: "31500000.00", balance_known: true },
    { currency: "EUR", first_gap: "2026-12-10", first_gap_with_plan: "2026-12-10", opening: "12000.00", balance_known: true }],
    nearest: { currency: "EUR", date: "2026-12-10", week: "2026-12-07" }, receivables: true, goods: true, incomplete: false, link: "/finance/cash" },
  { ...base, tile: "shelf_life", risk: { expired_kzt: "420000.00", critical_kzt: "1380000.00", warning_kzt: "3900000.00", expired_pieces: "310", critical_pieces: "1240",
    warning_pieces: "3600", urgent_kzt: "1800000.00", urgent_pieces: "1550", incomplete: 2 },
    losses: { cost_kzt: "265000.00", pieces: "190", lines: 6, incomplete_lines: 0 }, previous: { cost_kzt: "310000.00", pieces: "240" }, amounts: true,
    incomplete: true, link: "/analytics/losses?from=2026-11-01&to=2026-11-30" },
  { tile: "shipments", status: "error", month: "2026-11-01" },
  { ...base, tile: "decisions", approvals: 3, price_reviews: 2, blocked_orders: 1, tasks_overdue: 4, unpriced_orders: 2, total: 12, incomplete: false, link: "/notifications" },
];

function Page() {
  return <main className="workspace executive-workspace" style={{ margin: 0, width: "100%" }}>
    <header className="topbar"><div><p className="eyebrow">Руководителю · ноябрь 2026 г.</p><h1>Дашборд</h1></div></header>
    <p className="executive-attention"><strong>Требует внимания:</strong> {attention(tiles).join(" · ")}</p>
    <ExecutiveTiles tiles={tiles}/>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Page/>);
