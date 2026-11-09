import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "@/lib/supabase/select-all";
import { loadDocumentActions } from "@/lib/documents/load-actions";
import { DocumentActions } from "./document-actions";
import type { DocumentActionInfo } from "@/lib/documents/action-index";

type Entry = { title: string; actions: DocumentActionInfo };
export async function linkedDocuments(session: SupabaseClient, type: "contract" | "warehouse" | "customer" | "customer_return", ids: string[]) {
  const grouped = new Map<string, Entry[]>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 50) {
    const { data } = await selectAll((from, to) => session.from("document_links")
      .select("entity_id,document:documents!inner(id,title,archived_at)")
      .eq("entity_type", type).in("entity_id", unique.slice(start, start + 50)).is("removed_at", null)
      .is("document.archived_at", null).order("id").range(from, to)
      .returns<{ entity_id: string; document: { id: string; title: string } }[]>());
    const actions = await loadDocumentActions(session, (data ?? []).map(row => row.document.id));
    for (const { entity_id, document } of data ?? []) {
      const entries = grouped.get(entity_id) ?? [];
      if (actions[document.id] && !entries.some(entry => entry.actions.id === document.id)) {
        entries.push({ title: document.title, actions: actions[document.id] });
        grouped.set(entity_id, entries);
      }
    }
  }
  return grouped;
}

export function LinkedDocuments({ entries }: { entries?: Entry[] }) {
  if (!entries?.length) return null;
  return <ul className="linked-document-list">{entries.map(entry => <li key={entry.actions.id}>
    <strong>{entry.title}</strong><DocumentActions document={entry.actions}/>
  </li>)}</ul>;
}
