// Tiles of the executive dashboard (202611280400). Rendering only: the figures come from the tile function of the
// database. A tile that failed to load says "нет данных" and links to its source report; it never shows a zero.
import Link from "next/link";
import {
  amount, change, day, kzt, percent, tileSource, tileTitle,
  type DashboardTile, type ErrorTile, type CashTile, type DecisionsTile, type PayablesTile, type ReceivablesTile, type RevenueTile,
  type ShelfLifeTile, type ShipmentsTile,
} from "@/lib/dashboard/executive";

function Frame({ tile, children, value, note }: { tile: DashboardTile; children?: React.ReactNode; value: React.ReactNode; note?: React.ReactNode }) {
  const ok = tile.status === "ok";
  return <article className={`summary-card executive-tile${ok ? "" : " executive-tile-error"}`} aria-labelledby={`tile-${tile.tile}`}>
    <div className="executive-tile-head"><p id={`tile-${tile.tile}`}>{tileTitle[tile.tile]}</p>
      {ok && tile.incomplete && <span className="executive-badge">данные неполные</span>}</div>
    <strong>{value}</strong>
    {note && <small className="executive-note">{note}</small>}
    {children}
    <Link className="text-button executive-link" href={ok ? tile.link : tileSource[tile.tile]}>Открыть отчёт →</Link>
  </article>;
}

function ErrorView({ tile }: { tile: ErrorTile }) {
  return <Frame tile={tile} value="нет данных" note="Источник сейчас не ответил. Откройте исходный отчёт или обновите страницу."/>;
}

function Revenue({ tile }: { tile: RevenueTile }) {
  return <Frame tile={tile} value={kzt(tile.revenue_net)} note={change(tile.revenue_net, tile.previous.revenue_net) ?? "выручка без НДС"}>
    <dl className="executive-facts">
      <div><dt>Валовая прибыль</dt><dd>{kzt(tile.profit)}</dd></div>
      <div><dt>Маржа</dt><dd>{percent(tile.margin_pct)} <small>в прошлом месяце {percent(tile.previous.margin_pct)}</small></dd></div>
      <div><dt>Выручка с полными данными</dt><dd>{percent(tile.complete_share_pct)}{tile.incomplete_lines ? <small> · неполных строк {tile.incomplete_lines}</small> : null}</dd></div>
    </dl>
  </Frame>;
}

function Receivables({ tile }: { tile: ReceivablesTile }) {
  return <Frame tile={tile} value={tile.customers ? kzt(tile.overdue_kzt) : "нет просрочки"}
    note={tile.customers ? `оценка в тенге · должников: ${tile.customers}` : "все долги клиентов в срок"}>
    {tile.currencies.length > 0 && <p className="executive-currencies">{tile.currencies.map(item => <span key={item.currency}>{amount(item.overdue, item.currency)}</span>)}</p>}
    {tile.top.length > 0 && <ol className="executive-list">{tile.top.map(item => <li key={item.customer_id}>
      <Link href={`/finance/receivables/${item.customer_id}`}>{item.customer}</Link>
      <span>{item.amounts.map(a => amount(a.overdue, a.currency)).join(" · ")}{item.days ? ` · ${item.days} дн.` : ""}</span></li>)}</ol>}
  </Frame>;
}

function Payables({ tile }: { tile: PayablesTile }) {
  return <Frame tile={tile} value={kzt(tile.due_14_kzt)} note={`к оплате за 14 дней, оценка в тенге${tile.goods ? "" : " · без оплат за товар"}`}>
    <dl className="executive-facts">
      <div><dt>Просрочено</dt><dd className={tile.currencies.some(item => Number(item.overdue) > 0) ? "danger-text" : undefined}>{kzt(tile.overdue_kzt)}</dd></div>
      {tile.currencies.map(item => <div key={item.currency}><dt>{item.currency}</dt>
        <dd>{amount(item.due_14)} за 14 дн.{Number(item.overdue) ? <small> · просрочено {amount(item.overdue)}</small> : null}</dd></div>)}
    </dl>
  </Frame>;
}

function Cash({ tile }: { tile: CashTile }) {
  const unknown = tile.currencies.filter(item => !item.balance_known).map(item => item.currency);
  return <Frame tile={tile} value={tile.nearest ? `разрыв в ${tile.nearest.currency}` : "разрыва нет"}
    note={tile.nearest ? `с ${day(tile.nearest.date)} · неделя с ${day(tile.nearest.week)}` : "в ближайшие 13 недель"}>
    <dl className="executive-facts">{tile.currencies.map(item => <div key={item.currency}><dt>{item.currency}</dt>
      <dd>{!item.balance_known ? "остаток не введён" : item.first_gap ? `разрыв с ${day(item.first_gap)}` : item.first_gap_with_plan ? `с планом — с ${day(item.first_gap_with_plan)}` : "без разрыва"}</dd></div>)}</dl>
    {(unknown.length > 0 || !tile.receivables || !tile.goods) && <small className="executive-note">{[
      unknown.length ? `без остатка на счетах: ${unknown.join(", ")}` : null,
      !tile.receivables ? "без долгов клиентов" : null, !tile.goods ? "без оплат за товар" : null].filter(Boolean).join(" · ")}</small>}
  </Frame>;
}

function ShelfLife({ tile }: { tile: ShelfLifeTile }) {
  const risk = tile.amounts ? kzt(tile.risk.urgent_kzt) : `${amount(tile.risk.urgent_pieces)} шт.`;
  return <Frame tile={tile} value={risk} note={`истёк или до 30 дней${tile.amounts ? ", по себестоимости" : " (суммы — с правом на закупочные цены)"}`}>
    <dl className="executive-facts">
      <div><dt>Истёк</dt><dd>{tile.amounts ? kzt(tile.risk.expired_kzt) : `${amount(tile.risk.expired_pieces)} шт.`}</dd></div>
      <div><dt>До 30 дней</dt><dd>{tile.amounts ? kzt(tile.risk.critical_kzt) : `${amount(tile.risk.critical_pieces)} шт.`}</dd></div>
      <div><dt>До 90 дней</dt><dd>{tile.amounts ? kzt(tile.risk.warning_kzt) : `${amount(tile.risk.warning_pieces)} шт.`}</dd></div>
      <div><dt>Потери месяца</dt><dd>{tile.amounts ? kzt(tile.losses.cost_kzt) : `${amount(tile.losses.pieces)} шт.`}
        {tile.amounts && change(tile.losses.cost_kzt, tile.previous.cost_kzt) ? <small> · {change(tile.losses.cost_kzt, tile.previous.cost_kzt)}</small> : null}</dd></div>
    </dl>
  </Frame>;
}

function Shipments({ tile }: { tile: ShipmentsTile }) {
  return <Frame tile={tile} value={`${tile.vehicles_on_road} в пути`} note={`машин в дороге · поставок в работе ${tile.active}`}>
    <dl className="executive-facts">
      <div><dt>С опозданием</dt><dd className={tile.late ? "danger-text" : undefined}>{tile.late}</dd></div>
      <div><dt>Этапы просрочены</dt><dd className={tile.stages_late ? "danger-text" : undefined}>{tile.stages_late}{tile.stages_blocked ? <small> · заблокировано {tile.stages_blocked}</small> : null}</dd></div>
      <div><dt>Поставок в пути и на таможне</dt><dd>{tile.in_transit}</dd></div>
    </dl>
  </Frame>;
}

function Decisions({ tile }: { tile: DecisionsTile }) {
  return <Frame tile={tile} value={tile.total ? String(tile.total) : "всё решено"} note={tile.total ? "ждут вашего решения" : "нет непрочитанных запросов"}>
    <dl className="executive-facts">
      <div><dt><Link href="/notifications">Согласования</Link></dt><dd>{tile.approvals}</dd></div>
      <div><dt><Link href="/notifications">Проверьте цену</Link></dt><dd>{tile.price_reviews}</dd></div>
      <div><dt><Link href="/notifications">Заказ нельзя отгрузить</Link></dt><dd>{tile.blocked_orders}</dd></div>
      {tile.unpriced_orders != null && <div><dt><Link href="/sales">Заказы без цены</Link></dt><dd>{tile.unpriced_orders}</dd></div>}
      {tile.tasks_overdue != null && <div><dt><Link href="/tasks">Просроченные задачи</Link></dt><dd>{tile.tasks_overdue}</dd></div>}
    </dl>
  </Frame>;
}

export function ExecutiveTiles({ tiles }: { tiles: DashboardTile[] }) {
  return <section className="executive-grid" aria-label="Плитки дашборда">{tiles.map(tile => {
    if (tile.status !== "ok") return <ErrorView key={tile.tile} tile={tile}/>;
    switch (tile.tile) {
      case "revenue": return <Revenue key={tile.tile} tile={tile}/>;
      case "receivables": return <Receivables key={tile.tile} tile={tile}/>;
      case "payables": return <Payables key={tile.tile} tile={tile}/>;
      case "cash": return <Cash key={tile.tile} tile={tile}/>;
      case "shelf_life": return <ShelfLife key={tile.tile} tile={tile}/>;
      case "shipments": return <Shipments key={tile.tile} tile={tile}/>;
      case "decisions": return <Decisions key={tile.tile} tile={tile}/>;
    }
  })}</section>;
}
