import { formatDateTime } from "@/lib/documents/labels.ts";
import { telegramUpdateState, type TelegramRunRow, type TelegramUpdateRow } from "@/lib/telegram/update-state.ts";

/** Processing state of Telegram messages. No question, transcript or answer is stored or shown. */
export function TelegramUpdatesTable({ updates, runs, now, showUser = false }: {
  updates: Array<TelegramUpdateRow & { user?: { full_name: string | null } | Array<{ full_name: string | null }> | null }>;
  runs: TelegramRunRow[]; now: number; showUser?: boolean;
}) {
  if (!updates.length) return <div className="empty-state">Сообщений пока нет.</div>;
  const byId = new Map(runs.map((run) => [run.id, run]));
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Получено</th>{showUser && <th>Сотрудник</th>}<th>Состояние</th><th>Подробности</th></tr></thead>
        <tbody>
          {updates.map((row) => {
            const state = telegramUpdateState(row, row.run_id ? byId.get(row.run_id) : undefined, now);
            const user = Array.isArray(row.user) ? row.user[0] : row.user;
            return (
              <tr key={row.update_id}>
                <td>{formatDateTime(row.created_at)}</td>
                {showUser && <td>{user?.full_name ?? "—"}</td>}
                <td><span className={`doc-badge telegram-${state.tone}`}>{state.label}</span></td>
                <td><small>{state.detail || "—"}</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
