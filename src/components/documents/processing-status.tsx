"use client";
import { useEffect, useState } from "react";
import { processingState, processingErrors, type ProcessingReceipt } from "@/lib/documents/processing-status";
const stages: Record<string, string> = { checking: "Проверка доступа и предыдущей попытки", reading: "Чтение папки", recognizing: "Распознавание документа", downloading: "Скачивание и проверка файла", storage: "Сохранение файла Nexus", registering: "Регистрация результата", finished: "Результат сохранён" };
const states: Record<string, string> = { running: "Выполняется", completed: "Завершена", waiting_retry: "Ожидает повторения", needs_action: "Требуется действие сотрудника" };
const kinds: Record<string, string> = { scan: "Проверка папки", import: "Импорт", ocr: "Распознавание", bind: "Привязка", check: "Сравнение содержимого", link: "Связывание документа" };
export function ProcessingStatus({ receipts, serverNow }: { receipts: ProcessingReceipt[]; serverNow: number }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const origin = performance.now();
    const timer = setInterval(() => setNow(serverNow + performance.now() - origin), 10000);
    return () => clearInterval(timer);
  }, [serverNow]);
  if (!receipts.length) return null;
  const needsAttention = receipts.some(receipt => processingState(receipt, now) !== "completed");
  return <details aria-label="Последние операции" className="panel processing-status" open={needsAttention}>
    <summary>Последние операции · {needsAttention ? "есть незавершённые попытки" : "результаты сохранены"}</summary>
    <p>Последних операций в списке: {receipts.length}. Если ответ потерян, обновите страницу и проверьте сохранённый результат перед повтором.</p>
    {receipts.map(r => {
      const state = processingState(r, now), elapsed = Math.max(0, Date.parse(r.finished_at ?? r.updated_at) - Date.parse(r.started_at));
      return <article key={r.id} style={{ overflowWrap: "anywhere", marginTop: 12 }}>
        <strong>{states[state]} · {kinds[r.kind] ?? "Обработка документа"}</strong>
        <p>{stages[r.stage] ?? "Обработка документа"} · зафиксированная длительность {(elapsed / 1000).toFixed(1)} с</p>
        {(r.error_code || state === "needs_action") && <p role="status">{processingErrors[r.error_code ?? "INTERRUPTED"]}</p>}
        {state === "waiting_retry" && <p>Автоматический повтор не запущен. Проверьте сохранённый результат и повторите действие для этого файла.</p>}
        <details><summary>Сведения для поддержки</summary><small>Операция {r.id}</small></details>
      </article>;
    })}
  </details>;
}
