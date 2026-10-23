"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { OperationIntent } from "@/lib/agent/operations";

type Review = { id: string; kind?: OperationIntent["kind"]; status: "awaiting_confirmation" | "completed"; review_token?: string; result_id?: string; expires_at?: string;
 preview?: { product?: string; from?: string; to?: string; quantity?: number; uom?: string; document_date: string;
  order_number?: string; customer?: string; warehouse?: string; planned_date?: string;
  items?: { id: string; product: string; quantity: number; uom: string }[];
  lines: { balance_id?: string; id?: string; product?: string; batch: string; expiry: string | null; quantity: number; uom: string; sale_quantity?: number; sale_uom?: string }[] } };
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
  <p className="eyebrow">Действие только после вашего подтверждения</p><h3>{isOrder ? "Подготовка отгрузки заказа" : "Подготовка перемещения"}</h3>
  <p className="form-help">Предложение ассистента ещё не является документом. Просмотр не меняет остатки. Google Drive и Sheets — только чтение.</p>
  {intent && !review && !unknown && <button type="button" disabled={busy} onClick={() => void act("prepare")}>Проверить параметры и партии</button>}
  {intent && unknown && <button type="button" disabled={busy} onClick={() => void act("prepare")}>Повторить подготовку с прежним ID</button>}
  <button type="button" disabled={busy} onClick={() => void act("review")}>Проверить состояние</button>
  {error && <p role="alert" className="login-error admin-message">{error}</p>}
  {review?.status === "completed" && review.result_id && /^[0-9a-f-]{36}$/i.test(review.result_id) && <p className="login-success">{isOrder ? "Заказ отгружен." : "Перемещение выполнено."} <Link href={isOrder ? `/sales/${review.result_id}` : `/inventory/movements/${review.result_id}`}>{isOrder ? "Открыть заказ" : "Открыть складской документ"}</Link></p>}
  {review?.status === "awaiting_confirmation" && review.preview && <>
   {isOrder ? <>
    <h4>Заказ {review.preview.order_number}</h4>
    <dl className="assistant-values"><div><dt>Покупатель</dt><dd>{review.preview.customer}</dd></div><div><dt>Склад отгрузки</dt><dd>{review.preview.warehouse}</dd></div>
     <div><dt>Плановая дата</dt><dd>{review.preview.planned_date}</dd></div><div><dt>Дата операции</dt><dd>{review.preview.document_date}</dd></div></dl>
    <h4>Весь подтверждённый заказ</h4><ul>{review.preview.items?.map(item => <li key={item.id}>{item.product} — {item.quantity} {units[item.uom] ?? item.uom}</li>)}</ul>
   </> : <><h4>{review.preview.product}</h4>
   <dl className="assistant-values"><div><dt>Откуда</dt><dd>{review.preview.from}</dd></div><div><dt>Куда</dt><dd>{review.preview.to}</dd></div>
    <div><dt>По команде</dt><dd>{review.preview.quantity} {units[review.preview.uom ?? ""] ?? review.preview.uom}</dd></div><div><dt>Дата документа</dt><dd>{review.preview.document_date}</dd></div></dl></>}
   <p>{isOrder ? "Будут списаны зарезервированные партии:" : "Будут списаны со склада отправления и зачислены на склад назначения:"}</p>
   <ul>{review.preview.lines.map(line => <li key={line.id ?? line.balance_id}>{line.product ? `${line.product} · ` : ""}{line.batch} — {line.quantity} {units[line.uom] ?? line.uom}; годен до {line.expiry ?? "не указано"}
    {isOrder && line.sale_uom && <> (в заказе: {line.sale_quantity} {units[line.sale_uom] ?? line.sale_uom})</>}</li>)}</ul>
   <p className="form-help">{isOrder ? "Физический остаток уменьшится, резерв будет погашен, заказ станет отгруженным и будет учтён в дебиторской задолженности по существующим правилам. Оплата не создаётся. Частичная отгрузка здесь недоступна." : "Общий остаток компании не меняется."} Если данные изменились после просмотра, выполнение будет отклонено.</p>
   <label><input type="checkbox" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} /> {isOrder ? "Проверил заказ, покупателя, склад, партии и все количества; подтверждаю полную отгрузку" : "Проверил товар, склады, партии и количество"}</label>
   <div className="panel-footer-actions"><button className="primary" type="button" disabled={busy || !checked} onClick={() => void act("confirm")}>{isOrder ? "Подтвердить и отгрузить заказ полностью" : "Подтвердить и выполнить перемещение"}</button></div>
  </>}
  {!busy && !unknown && <button type="button" onClick={() => { requestId.current = null; preparedIntent.current = null; setReview(null); setChecked(false); setError(null); sessionStorage.removeItem("nexus-assistant-operation-id"); }}>Начать новый просмотр</button>}
 </section>;
}
