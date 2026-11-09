"use client";

import { DocumentActions } from "@/components/documents/document-actions";
import type { DocumentActionIndex } from "@/lib/documents/action-index";
import Link from "next/link";
import { preparationRequest } from "@/lib/agent/shipment-workflow";
import { useRef, useState } from "react";
import type { AgentAnswer } from "@/lib/agent/types";
import { RequestProgress } from "./request-progress";
import { OperationReview } from "./operation-review";

type Event =
  | { type: "stage"; label: string }
  | { type: "result"; answer: AgentAnswer; documentActions?: DocumentActionIndex; requestsUsed: number; requestLimit: number }
  | { type: "error"; code: string; message: string; refunded: boolean };

// Only server-built relative links to known Nexus pages are rendered.
const SAFE_LINK = /^\/assistant\/archive\/[A-Za-z0-9_-]{10,120}$|^\/(shipments|documents|products|counterparties|warehouses|sales|templates|listing-cards)\/[0-9a-f-]{36}$|^\/(tasks|routes|suppliers|notifications|calendar|inventory|inventory\/movements|stickers|forecasts|purchase-plans|commercial-programs|finance|integrations|audit|admin\/users|admin\/roles)$|^\/products\?q=[^\s]*$/;

export function AssistantChat({ initialUsed, limit, operationsEnabled = false, initialQuestion = "" }: { initialUsed: number; limit: number; operationsEnabled?: boolean; initialQuestion?: string }) {
  const [question, setQuestion] = useState(initialQuestion);
  const [preparation, setPreparation] = useState<ReturnType<typeof preparationRequest>>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [documentActions, setDocumentActions] = useState<DocumentActionIndex>({});
  const [answer, setAnswer] = useState<AgentAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState(initialUsed);
  const asked = useRef("");
  const conversation = useRef<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true);
    setStages([]);
    setAnswer(null);
    setError(null);
    asked.current = question.trim();
    const prepare = operationsEnabled ? preparationRequest(asked.current) : null;
    setPreparation(prepare);
    if (prepare) { setBusy(false); return; }
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: asked.current, conversationId: conversation.current ?? (conversation.current = crypto.randomUUID()) }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? "Ассистент недоступен.");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const item = JSON.parse(line) as Event;
          if (item.type === "stage") setStages((current) => [...current, item.label]);
          else if (item.type === "result") {
            setDocumentActions(item.documentActions ?? {});
            setAnswer(item.answer);
            setUsed(item.requestsUsed);
          } else setError(item.message);
        }
      }
    } catch {
      setError("Сервер не ответил. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel admin-section assistant-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">{operationsEnabled ? "Ваши права · действия после подтверждения" : "Только чтение · ваши права"}</p><h2>Вопрос ассистенту</h2></div>
        <span className="page-count">{used} из {limit} сегодня</span>
      </div>
      <form className="doc-form" onSubmit={submit} aria-busy={busy}>
        <label className="doc-form-full">Вопрос
          <textarea name="question" rows={3} maxLength={1000} value={question} onChange={(event) => setQuestion(event.target.value)}
            placeholder="Например: какие поставки задерживаются? Какие документы есть по поставке NAR-2026-0001?" disabled={busy} />
        </label>
        <p className="form-help doc-form-full">Контекст последних вопросов сохраняется на 30 минут в этой беседе. Данные проверяются заново. Номера удостоверений, паспортные данные и ключи скрываются до отправки модели. Финансовые данные доступны только по вашим правам.</p>
        <div className="doc-form-full"><button className="primary" type="submit" disabled={busy || !question.trim()}>{busy ? "Обрабатываю…" : "Спросить"}</button> <button type="button" disabled={busy} onClick={() => { conversation.current = null; setAnswer(null); setStages([]); setError(null); setQuestion(""); setPreparation(null); }}>Новая беседа</button></div>
      </form>

      {preparation && <section className="setup-notice" role="status"><h3>Подготовка поставки из документов</h3><p>Выберите поставку, проверьте папку, загрузите выбранные файлы и сверьте результаты. Ничего ещё не создано, не загружено и не проведено.</p><Link className="primary button-link" href={preparation.href}>Открыть подготовку поставки</Link></section>}
      {busy && <RequestProgress label={stages.at(-1) ? `${stages.at(-1)}…` : "Ассистент обрабатывает вопрос…"} />}

      {(busy || stages.length > 0) && !answer && (
        <ol className="assistant-stages" aria-live="polite">
          {stages.map((label, index) => <li key={`${label}-${index}`}>{label}{busy && index === stages.length - 1 ? "…" : ""}</li>)}
        </ol>
      )}
      {error && <div role="alert" className="login-error admin-message">{error}</div>}
      {operationsEnabled && <OperationReview intent={answer?.operationIntent} />}

      {answer && (
        <div className="assistant-answer">
          <p className="form-help">Вопрос: {asked.current}</p>
          <p role="status" className="setup-notice">{answer.operationIntent
            ? "Предложение подготовлено. Его проверка, подтверждение и результат — в блоке операции выше."
            : "Ответ получен. Операция не подготовлена и не выполнена. Если ассистент просит уточнения, укажите недостающие данные следующим вопросом."}</p>
          <h3>Проверенные данные Nexus</h3>
          {answer.facts.length === 0 && <p className="form-help">Проверенных данных в ответе нет.</p>}
          {answer.facts.map((fact, index) => (
            <article key={index} className="assistant-block assistant-fact">
              <span className="doc-badge">Факт · сформирован из данных Nexus</span>
              <p><strong>{fact.subject}</strong></p>
              <dl className="assistant-values">
                {fact.values.map((value) => <div key={value.field}><dt>{value.label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{value.value}</dd></div>)}
              </dl>
              <small>источник: {fact.source.tool}{fact.source.row >= 0 ? `, запись ${fact.source.row + 1}` : ""}</small>
              {fact.link && SAFE_LINK.test(fact.link.href) && (fact.link.href.startsWith("/documents/") && documentActions[fact.link.href.slice("/documents/".length)]
                ? <DocumentActions document={documentActions[fact.link.href.slice("/documents/".length)]}/>
                : <Link className="text-button" href={fact.link.href}>{fact.link.href.startsWith("/assistant/archive/") ? "Скачать оригинал" : `Открыть: ${fact.link.label}`}</Link>)}
            </article>
          ))}
          {answer.commentary.length > 0 && (
            <div className="assistant-commentary">
              <h3>Пояснения модели</h3>
              {answer.commentary.map((item, index) => (
                <article key={index} className="assistant-block assistant-assumption">
                  <span className="doc-badge">{item.kind === "assumption" ? "Предположение · не проверено" : "Пояснение модели · не проверено"}</span>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          )}
          {answer.rejected.length > 0 && (
            <div className="setup-notice"><strong>Отклонено при проверке</strong><ul>{answer.rejected.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
          )}
          {answer.limitations.length > 0 && (
            <div className="setup-notice"><strong>Ограничения ответа</strong><ul>{answer.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
          )}
          <p className="form-help">Использованы данные: {answer.toolsUsed.length ? answer.toolsUsed.join(", ") : "нет"}.</p>
        </div>
      )}
    </section>
  );
}
