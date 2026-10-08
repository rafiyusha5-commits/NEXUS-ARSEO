"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { AgentAnswer } from "@/lib/agent/types";

type Event =
  | { type: "stage"; label: string }
  | { type: "result"; answer: AgentAnswer; requestsUsed: number; requestLimit: number }
  | { type: "error"; code: string; message: string; refunded: boolean };

// Only server-built relative links to known Nexus pages are rendered.
const SAFE_LINK = /^\/(shipments|documents)\/[0-9a-f-]{36}$|^\/tasks$/;

export function AssistantChat({ initialUsed, limit }: { initialUsed: number; limit: number }) {
  const [question, setQuestion] = useState("");
  const [stages, setStages] = useState<string[]>([]);
  const [answer, setAnswer] = useState<AgentAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState(initialUsed);
  const asked = useRef("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true);
    setStages([]);
    setAnswer(null);
    setError(null);
    asked.current = question.trim();
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: asked.current }),
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
        <div><p className="eyebrow">Только чтение · ваши права</p><h2>Вопрос ассистенту</h2></div>
        <span className="page-count">{used} из {limit} сегодня</span>
      </div>
      <form className="doc-form" onSubmit={submit}>
        <label className="doc-form-full">Вопрос
          <textarea name="question" rows={3} maxLength={1000} value={question} onChange={(event) => setQuestion(event.target.value)}
            placeholder="Например: какие поставки задерживаются? Какие документы есть по поставке NAR-2026-0001?" disabled={busy} />
        </label>
        <p className="form-help doc-form-full">Каждый вопрос обрабатывается отдельно. Номера удостоверений, паспортные данные и ключи скрываются до отправки модели. Закупочные цены и себестоимость ассистенту недоступны.</p>
        <div className="doc-form-full"><button className="primary" type="submit" disabled={busy || !question.trim()}>{busy ? "Обрабатываю…" : "Спросить"}</button></div>
      </form>

      {(busy || stages.length > 0) && !answer && (
        <ol className="assistant-stages" aria-live="polite">
          {stages.map((label, index) => <li key={`${label}-${index}`}>{label}{busy && index === stages.length - 1 ? "…" : ""}</li>)}
        </ol>
      )}
      {error && <div className="login-error admin-message">{error}</div>}

      {answer && (
        <div className="assistant-answer">
          <p className="form-help">Вопрос: {asked.current}</p>
          {answer.blocks.map((block, index) => (
            <article key={index} className={`assistant-block assistant-${block.kind}`}>
              <span className="doc-badge">{block.kind === "fact" ? "Факт · проверено по данным" : block.kind === "assumption" ? "Предположение" : "Не подтверждено"}</span>
              <p>{block.text}</p>
              {block.kind === "unverified" && <small>{block.reason}</small>}
              {block.kind === "fact" && block.values.length > 0 && (
                <dl className="assistant-values">
                  {block.values.map((value, valueIndex) => (
                    <div key={valueIndex}><dt>{value.label}</dt><dd>{value.value}</dd><small>источник: {value.tool}{value.row >= 0 ? `, запись ${value.row + 1}` : ""}</small></div>
                  ))}
                </dl>
              )}
              {block.kind === "fact" && block.links.filter((item) => SAFE_LINK.test(item.href)).map((item) => (
                <Link key={item.href} className="text-button" href={item.href}>Открыть: {item.label}</Link>
              ))}
            </article>
          ))}
          {answer.limitations.length > 0 && (
            <div className="setup-notice"><strong>Ограничения ответа</strong><ul>{answer.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
          )}
          <p className="form-help">Использованы данные: {answer.toolsUsed.length ? answer.toolsUsed.join(", ") : "нет"}.</p>
        </div>
      )}
    </section>
  );
}
