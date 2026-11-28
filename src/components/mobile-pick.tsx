// Picking an order from a phone (202611280600): the walk through the places, the scan of each batch, the pick and the
// shipment. Rendering only, shared by the page and its browser test; the database refuses a batch that is not reserved.
import Link from "next/link";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { ScanFeedback } from "@/components/scan-feedback";
import { ScanField } from "@/components/scan-field";
import { quantity, shortDate, uomName } from "@/lib/scan/lookup";
import { nextPick, pickDone, remaining, type PickLine, type PickList, type PickMatch } from "@/lib/scan/operations";

type Action = (data: FormData) => void | Promise<void>;
const unit = (uom: string) => uom === "piece" ? "шт." : uomName[uom] ?? uom;
const place = (line: PickLine) => line.location ?? "без зоны";

export function PickOrderView({ list, match, code, batch, message, pickAction, shipAction }: {
  list: PickList; match: PickMatch | null; code?: string; batch?: string; message?: { type: "error" | "success"; text: string } | null;
  pickAction: Action; shipAction: Action;
}) {
  const next = nextPick(list);
  const done = pickDone(list);
  const picked = list.lines.filter(line => remaining(line) === 0).length;
  const target = `/m/pick/${list.sale_id}`;
  return <>
    <h1 className="mobile-title">Отбор {list.sale_number}</h1>
    <p className="mobile-hint">{list.customer ?? "—"} · отобрано строк {picked} из {list.lines.length}</p>
    {message && <div className={`${message.type === "error" ? "login-error" : "login-success"} admin-message`}>{message.text}</div>}
    {list.status !== "confirmed" && <section className="mobile-card mobile-card-warning"><strong>Заказ не подтверждён</strong>
      <small>{list.status === "shipped" ? "Заказ уже отгружен." : "Отбирать можно только подтверждённый заказ."}</small></section>}
    {list.status === "confirmed" && !done && <ScanField target={target} label="Отсканируйте партию, которую берёте" placeholder="Этикетка партии или GS1-код"/>}
    {match && <MatchCard list={list} match={match} code={code} batch={batch} pickAction={pickAction}/>}
    {list.status === "confirmed" && next && !(match?.kind === "pick") && <section className="mobile-card mobile-next">
      <small>Следующее</small>
      <strong className="mobile-big">Место {place(next)}</strong>
      <span>{next.sku} · {next.product}</span>
      <span>партия <strong>{next.batch}</strong> · годен до {shortDate(next.expiry_date)}</span>
      <span className="mobile-next-qty">взять {quantity(remaining(next))} {unit(next.uom)}</span>
    </section>}
    {list.status === "confirmed" && done && <section className="mobile-card mobile-card-ok">
      <strong className="mobile-big">Всё отобрано</strong>
      <small>Проверьте упаковку и отгрузите: остаток спишется по резервам заказа, как при отгрузке из карточки.</small>
      <form action={shipAction} className="mobile-form"><input type="hidden" name="sale_id" value={list.sale_id}/>
        <PendingSubmitButton pendingText="Отгружаем…" className="primary scan-button" type="submit">Отгрузить заказ</PendingSubmitButton></form>
    </section>}
    <section className="mobile-card"><strong>Строки отбора</strong>
      {list.lines.length ? <ul className="mobile-stock">{list.lines.map(line => <li key={line.reservation_id} className={remaining(line) === 0 ? "mobile-line-done" : ""}>
        <div><strong>{place(line)} · {line.sku}</strong><small>{line.product}</small><small>партия {line.batch} · до {shortDate(line.expiry_date)}</small></div>
        <div className="mobile-qty"><strong>{quantity(line.picked)}</strong><small>из {quantity(line.quantity)} {unit(line.uom)}{remaining(line) === 0 ? " ✓" : ""}</small></div>
      </li>)}</ul> : <p className="mobile-hint">Действующих резервов нет.</p>}
    </section>
    <p><Link href="/m/pick">← Заказы к отбору</Link></p>
  </>;
}

function MatchCard({ list, match, code, batch, pickAction }: { list: PickList; match: PickMatch; code?: string; batch?: string; pickAction: Action }) {
  const signature = `${code ?? ""}:${batch ?? ""}:${match.kind}`;
  if (match.kind === "pick") {
    const line = match.line;
    return <section className="mobile-card mobile-card-ok"><ScanFeedback ok signature={signature}/>
      <small>Партия совпадает с резервом</small>
      <strong className="mobile-big">{line.sku} · партия {line.batch}</strong>
      <span>место {place(line)} · осталось взять {quantity(remaining(line))} {unit(line.uom)}</span>
      <span>годен до <strong>{shortDate(line.expiry_date)}</strong> — сверьте с коробкой</span>
      {!!match.other_expiries?.length && <p className="load-warning-text">Партия {line.batch} есть и со сроком {match.other_expiries.map(shortDate).join(", ")}:
        возьмите коробки со сроком {shortDate(line.expiry_date)}.</p>}
      <form action={pickAction} className="mobile-form">
        <input type="hidden" name="sale_id" value={list.sale_id}/><input type="hidden" name="reservation_id" value={line.reservation_id}/>
        <input type="hidden" name="batch_id" value={line.batch_id}/><input type="hidden" name="location_id" value={line.location_id ?? ""}/>
        <label>Взято, {unit(line.uom)}<input name="quantity" inputMode="decimal" required defaultValue={String(remaining(line))} autoFocus/></label>
        <PendingSubmitButton pendingText="Записываем…" className="primary scan-button" type="submit">Подтвердить отбор</PendingSubmitButton>
      </form>
    </section>;
  }
  if (match.kind === "done") return <section className="mobile-card"><ScanFeedback ok={false} signature={signature}/>
    <strong className="mobile-big">Партия {match.line.batch} уже отобрана</strong><small>По этой строке взято всё, что зарезервировано.</small></section>;
  if (match.kind === "need_batch") return <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={signature}/>
    <strong className="mobile-big">Нужна партия</strong>
    <small>Код {match.product} не называет партию. Отсканируйте этикетку партии или GS1-код с партией — или введите номер партии с упаковки.</small>
    <form className="mobile-form" action={`/m/pick/${list.sale_id}`}><input type="hidden" name="code" value={code ?? ""}/><input type="hidden" name="via" value="manual"/>
      <label>Номер партии на упаковке<input name="batch" required autoCapitalize="characters" autoComplete="off"/></label>
      <button className="secondary scan-button" type="submit">Проверить партию</button></form>
  </section>;
  if (match.kind === "foreign") return <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={signature}/>
    <strong className="mobile-big">Эта партия не из резерва заказа{match.batch ? `: ${match.batch}` : ""}</strong>
    {match.expected && <span>Возьмите партию <strong>{match.expected.batch}</strong>, место <strong>{place(match.expected)}</strong>.</span>}
    <small>{list.can_replace
      ? <>Заменить партию в резерве можно в <Link href={`/sales/${list.sale_id}`}>карточке заказа</Link> — заменой резерва с причиной.</>
      : "Заменить партию может только сотрудник с правом отступать от FEFO — сообщите менеджеру заказа."}</small>
  </section>;
  return <section className="mobile-card mobile-card-warning"><ScanFeedback ok={false} signature={signature}/>
    <strong className="mobile-big">Код не относится к заказу</strong><small>Отсканируйте этикетку партии или код на коробке.</small></section>;
}
