"use client";
import { useEffect, useState } from "react";
import { processingState, processingErrors, type ProcessingReceipt } from "@/lib/documents/processing-status";
const stages: Record<string, string> = { checking: "Проверка прав и квитанции", reading: "Чтение папки", recognizing: "Распознавание документа", downloading: "Скачивание и проверка файла", storage: "Сохранение файла Nexus", registering: "Регистрация результата", finished: "Результат сохранён" };
const states: Record<string, string> = { running: "Выполняется", completed: "Завершена", failed: "Не выполнена", needs_action: "Требуется действие сотрудника" };
export function ProcessingStatus({ receipts, serverNow }: { receipts: ProcessingReceipt[]; serverNow: number }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const origin = performance.now();
    const timer = setInterval(() => setNow(serverNow + performance.now() - origin), 10000);
    return () => clearInterval(timer);
  }, [serverNow]);
  if (!receipts.length) return null;
  return <section aria-label="Последние операции" className="panel">
    <h3>Последние операции (до 20)</h3>
    <p>После обновления страницы показывается сохранённое состояние. Если ответ потерян, сначала проверьте результат; повтор импорта использует квитанцию.</p>
    {receipts.map(r => {
      const state = processingState(r, now), elapsed = Math.max(0, Date.parse(r.finished_at ?? r.updated_at) - Date.parse(r.started_at));
      return <article key={r.id} style={{ overflowWrap: "anywhere", marginTop: 12 }}>
        <strong>{states[state]} · {r.kind === "scan" ? "Проверка папки" : r.kind === "import" ? "Импорт" : r.kind === "ocr" ? "Распознавание" : "Привязка"}</strong>
        <p>{stages[r.stage]} · зафиксированная длительность {(elapsed / 1000).toFixed(1)} с</p>
        {(r.error_code || state === "needs_action") && <p role="status">{processingErrors[r.error_code ?? "INTERRUPTED"]}</p>}
        <small>Операция {r.id}</small>
      </article>;
    })}
  </section>;
}
