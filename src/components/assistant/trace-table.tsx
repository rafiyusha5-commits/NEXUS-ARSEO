import { formatDateTime } from "@/lib/documents/labels.ts";

export type TraceRun = {
  id: string; status: string; channel: string; question_excerpt: string | null; error_code: string | null;
  tools: Array<{ name?: string; params?: Record<string, unknown>; rows?: number; truncated?: boolean; ms?: number; error?: string }> | null;
  steps: number; tool_calls: number; input_tokens: number; output_tokens: number; actual_usd_micros: number;
  request_refunded: boolean; cost_status?: string; created_at: string; finished_at: string | null; user?: { full_name: string | null } | Array<{ full_name: string | null }> | null;
};

const STATUS: Record<string, string> = { running: "Выполняется", completed: "Ответ получен (не подтверждение операции)", failed: "Ошибка", rejected: "Отклонён" };
const COST: Record<string, string> = {
  reserved: "резерв", actual: "по отчёту сервера", estimated: "оценка: списан весь резерв", reconciled: "сверено после позднего завершения",
};

function userName(value: TraceRun["user"]): string {
  const user = Array.isArray(value) ? value[0] : value;
  return user?.full_name ?? "—";
}

/** Safe trace: masked excerpt, tools, safe parameters and usage. The full answer is not stored. */
export function TraceTable({ runs, showUser }: { runs: TraceRun[]; showUser: boolean }) {
  if (!runs.length) return <div className="empty-state">Запросов пока нет.</div>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Время</th>{showUser && <th>Сотрудник</th>}<th>Вопрос (выдержка, скрыто)</th><th>Статус</th><th>Инструменты</th><th>Расход</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{formatDateTime(run.created_at)}</td>
              {showUser && <td>{userName(run.user)}</td>}
              <td>{run.question_excerpt ?? "—"}</td>
              <td>
                {STATUS[run.status] ?? run.status}
                {run.error_code && <><br /><small>{run.error_code}</small></>}
                {run.request_refunded && <><br /><small>запрос возвращён</small></>}
              </td>
              <td>
                {(run.tools ?? []).length ? (
                  <ul className="assistant-trace-tools">
                    {(run.tools ?? []).map((tool, index) => (
                      <li key={index}>
                        {tool.name}{tool.params && Object.keys(tool.params).length ? ` (${Object.entries(tool.params).map(([key, value]) => `${key}: ${String(value)}`).join(", ")})` : ""}
                        {" — "}{tool.error ? tool.error : `${tool.rows ?? 0} зап.${tool.truncated ? ", неполный" : ""}`}
                      </li>
                    ))}
                  </ul>
                ) : "—"}
              </td>
              <td><small>шагов {run.steps}, вызовов {run.tool_calls}<br />токены {run.input_tokens} / {run.output_tokens}<br />${(run.actual_usd_micros / 1_000_000).toFixed(4)}{run.cost_status ? ` (${COST[run.cost_status] ?? run.cost_status})` : ""}</small></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
