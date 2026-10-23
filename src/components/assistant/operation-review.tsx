"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { OperationIntent } from "@/lib/agent/operations";

type Review = { id: string; kind?: OperationIntent["kind"]; status: "awaiting_confirmation" | "completed"; review_token?: string; result_id?: string; expires_at?: string;
 preview?: { product?: string; from?: string; to?: string; quantity?: number; uom?: string; document_date: string;
  low_shelf_life?: boolean; order_number?: string; customer?: string; warehouse?: string; planned_date?: string;
  contract?: string | null; contract_currency?: string | null; contract_valid_from?: string | null; contract_valid_to?: string | null; currency?: string; total?: string;
  items?: { id: string; product: string; quantity: number | string; uom: string; unit_price?: string; line_amount?: string; required_shelf_life_pct?: number | null }[];
  lines: { remaining_shelf_life_pct?: number | null; required_shelf_life_pct?: number | null; balance_id?: string; id?: string; product?: string; batch: string; expiry: string | null; quantity: number; uom: string; sale_quantity?: number; sale_uom?: string }[] } };
const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };

export function OperationReview({ intent }: { intent?: OperationIntent }) {
 const [review, setReview] = useState<Review | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [checked, setChecked] = useState(false);
 const [unknown, setUnknown] = useState(false);
 const requestId = useRef<string | null>(null);
 const inFlight = useRef(false);
 const preparedIntent = useRef<string | null>(null);
 const isOrder = (review?.kind ?? intent?.kind) === "customer_order_fulfillment";
 const isConfirm = (review?.kind ?? intent?.kind) === "customer_order_confirm";
 const isReserve = (review?.kind ?? intent?.kind) === "customer_order_reserve";
 const isDraft = (review?.kind ?? intent?.kind) === "customer_order_create";
 async function act(action: "prepare" | "review" | "confirm") {
  if (inFlight.current) return;
  if (action === "prepare" && !intent) return;
  if (action === "prepare" && !requestId.current && sessionStorage.getItem("nexus-assistant-operation-id")) {
   setError("В этой вкладке сохранена предыдущая операция. Сначала нажмите «Проверить состояние»."); return;
  }
  if (action === "confirm" && (!checked || !review?.review_token || unknown)) return;
  if (action === "prepare" && requestId.current && preparedIntent.current !== null && preparedIntent.current !== JSON.stringify(intent)) {
   setError("Сначала проверьте результат предыдущей операции или начните новый просмотр."); return;
  }
  if (action === "review" && !requestId.current) requestId.current = sessionStorage.getItem("nexus-assistant-operation-id");
  if (action !== "prepare" && !requestId.current) { setError("Сохранённой операции в этой вкладке нет."); return; }
  if (!requestId.current) requestId.current = crypto.randomUUID();
  if (action === "prepare") preparedIntent.current = JSON.stringify(intent);
  sessionStorage.setItem("nexus-assistant-operation-id", requestId.current);
  inFlight.current = true; setBusy(true); setError(null);
  try {
   const response = await fetch("/api/assistant/operations", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, id: requestId.current, ...(action === "prepare" ? { intent } : {}), ...(action === "confirm" ? { token: review?.review_token } : {}) }) });
   const result = await response.json();
   if (!response.ok) { setError(result.error ?? "Операция недоступна"); setChecked(false); setReview(null); return; }
   setReview(result as Review); setChecked(false); setUnknown(false);
  } catch {
   setUnknown(true); setChecked(false); setReview(null);
   setError("Ответ не получен. Операция могла сохраниться. Нажмите «Проверить состояние», прежде чем повторять действие.");
  } finally { inFlight.current = false; setBusy(false); }
 }
 return <section className="panel admin-section" aria-busy={busy} aria-label="Проверка предложенной операции">
  <p className="eyebrow">Действие только после вашего подтверждения</p><h3>{isConfirm ? "Подготовка подтверждения заказа" : isReserve ? "Подготовка резервирования" : isDraft ? "Подготовка нового заказа" : isOrder ? "Подготовка отгрузки заказа" : "Подготовка перемещения"}</h3>
  <p className="form-help">Предложение ассистента ещё не является документом. Просмотр не меняет остатки. Google Drive и Sheets — только чтение.</p>
  {intent && !review && !unknown && <button type="button" disabled={busy} onClick={() => void act("prepare")}>{isDraft ? "Проверить параметры заказа" : "Проверить параметры и партии"}</button>}
  {intent && unknown && <button type="button" disabled={busy} onClick={() => void act("prepare")}>Повторить подготовку с прежним ID</button>}
  <button type="button" disabled={busy} onClick={() => void act("review")}>Проверить состояние</button>
  {error && <p role="alert" className="login-error admin-message">{error}</p>}
  {review?.status === "completed" && review.result_id && /^[0-9a-f-]{36}$/i.test(review.result_id) && <p className="login-success">{isConfirm ? "Заказ подтверждён. Резервы сохранены, отгрузка не выполнялась." : isReserve ? "Товар зарезервирован. Заказ не подтверждён и не отгружен." : isDraft ? "Черновик заказа создан. Резерв и отгрузка не выполнялись." : isOrder ? "Заказ отгружен." : "Перемещение выполнено."} <Link href={isOrder || isDraft || isReserve || isConfirm ? `/sales/${review.result_id}` : `/inventory/movements/${review.result_id}`}>{isOrder || isDraft || isReserve || isConfirm ? "Открыть заказ" : "Открыть складской документ"}</Link></p>}
  {review?.status === "awaiting_confirmation" && review.preview && <>
   {isOrder || isDraft || isReserve || isConfirm ? <>
    <h4>{isDraft ? "Новый заказ · черновик" : `Заказ ${review.preview.order_number}`}</h4>
    <dl className="assistant-values"><div><dt>Покупатель</dt><dd>{review.preview.customer}</dd></div><div><dt>Склад отгрузки</dt><dd>{review.preview.warehouse}</dd></div>
     <div><dt>Плановая дата</dt><dd>{review.preview.planned_date}</dd></div><div><dt>Дата операции</dt><dd>{review.preview.document_date}</dd></div></dl>
    {isDraft && <><dl className="assistant-values"><div><dt>Договор</dt><dd>{review.preview.contract ?? "Без договора — проверьте выбор"}</dd></div><div><dt>Валюта заказа</dt><dd>{review.preview.currency}</dd></div></dl>
     {review.preview.contract && <p className="form-help">Договор: с {review.preview.contract_valid_from ?? "дата не задана"} по {review.preview.contract_valid_to ?? "дата не задана"}; валюта договора: {review.preview.contract_currency ?? "не задана"}. Проверьте соответствие выбранным условиям.</p>}</>}
    <h4>{isConfirm || isReserve ? "Позиции заказа" : isDraft ? "Предлагаемые позиции и цены" : "Весь подтверждённый заказ"}</h4><ul>{review.preview.items?.map(item => <li key={item.id}>{item.product} — {item.quantity} {units[item.uom] ?? item.uom}
     {isDraft && <><br />Цена за {units[item.uom] ?? item.uom}: {item.unit_price} {review.preview?.currency}; сумма строки: {item.line_amount} {review.preview?.currency}.<br />ОСГ покупателя: {item.required_shelf_life_pct == null ? "не задано" : `${item.required_shelf_life_pct}%`}</>}</li>)}</ul>
    {isDraft && <p><strong>Итого: {review.preview.total} {review.preview.currency}</strong><br /><span className="form-help">Итог округлён до 2 знаков, как в существующем расчёте заказа Nexus. Дополнительный налог или скидка автоматически не добавляются.</span></p>}
   </> : <><h4>{review.preview.product}</h4>
   <dl className="assistant-values"><div><dt>Откуда</dt><dd>{review.preview.from}</dd></div><div><dt>Куда</dt><dd>{review.preview.to}</dd></div>
    <div><dt>По команде</dt><dd>{review.preview.quantity} {units[review.preview.uom ?? ""] ?? review.preview.uom}</dd></div><div><dt>Дата документа</dt><dd>{review.preview.document_date}</dd></div></dl></>}
   {!isDraft && <><p>{isConfirm ? "Сохраняются текущие зарезервированные партии — без списания:" : isReserve ? "Будут зарезервированы партии (физический остаток не меняется):" : isOrder ? "Будут списаны зарезервированные партии:" : "Будут списаны со склада отправления и зачислены на склад назначения:"}</p>
   <ul>{review.preview.lines.map(line => <li key={line.id ?? line.balance_id}>{line.product ? `${line.product} · ` : ""}{line.batch} — {line.quantity} {units[line.uom] ?? line.uom}; годен до {line.expiry ?? "не указано"}
    {(isOrder || isReserve || isConfirm) && line.sale_uom && <> (в заказе: {line.sale_quantity} {units[line.sale_uom] ?? line.sale_uom})</>}{(isReserve || isConfirm) && <><br />ОСГ: {line.remaining_shelf_life_pct ?? "не установлено"}%; требование: {line.required_shelf_life_pct ?? "не задано"}{line.required_shelf_life_pct != null ? "%" : ""}</>}</li>)}</ul></>}
   {isReserve && review.preview.low_shelf_life && <p role="note" className="admin-message">ОСГ части партий ниже требования покупателя. Можно продолжить только резервирование. Для подтверждения заказа потребуется гарантийное письмо на конкретные позиции и партии. Нажатие кнопки не утверждает письмо и не разрешает отгрузку.</p>}
   <p className="form-help">{isConfirm ? "Заказ станет подтверждённым. Физический остаток, резервы и платежи не меняются. Отгрузка — отдельное действие. При выполнении также проверяются действующие финансовые ограничения; их обход здесь невозможен." : isReserve ? "Создаётся резерв всего заказа по существующему FEFO. Физический остаток, цены, платежи и долг не меняются. Подтверждение заказа — отдельное действие." : isDraft ? "Будет создан только черновик с позициями. Наличие товара не гарантируется: резервирование, подтверждение заказа и отгрузка выполняются отдельно. Остатки, платежи и задолженность не меняются." : isOrder ? "Физический остаток уменьшится, резерв будет погашен, заказ станет отгруженным и будет учтён в дебиторской задолженности по существующим правилам. Оплата не создаётся. Частичная отгрузка здесь недоступна." : "Общий остаток компании не меняется."} Если данные изменились после просмотра, выполнение будет отклонено.</p>
   <label><input type="checkbox" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} /> {isConfirm ? "Проверил заказ, покупателя, партии и количества; подтверждаю заказ без отгрузки" : isReserve ? "Проверил партии, количество и ОСГ; понимаю, что резерв не означает разрешение на отгрузку" : isDraft ? "Проверил покупателя, договор, склад, дату, валюту, все количества и цены" : isOrder ? "Проверил заказ, покупателя, склад, партии и все количества; подтверждаю полную отгрузку" : "Проверил товар, склады, партии и количество"}</label>
   <div className="panel-footer-actions"><button className="primary" type="button" disabled={busy || !checked} onClick={() => void act("confirm")}>{isConfirm ? "Подтвердить заказ без отгрузки" : isReserve ? review.preview.low_shelf_life ? "Продолжить резервирование с предупреждением" : "Подтвердить резервирование" : isDraft ? "Подтвердить и создать черновик заказа" : isOrder ? "Подтвердить и отгрузить заказ полностью" : "Подтвердить и выполнить перемещение"}</button></div>
  </>}
  {!busy && !unknown && <button type="button" onClick={() => { requestId.current = null; preparedIntent.current = null; setReview(null); setChecked(false); setError(null); sessionStorage.removeItem("nexus-assistant-operation-id"); }}>Начать новый просмотр</button>}
 </section>;
}
