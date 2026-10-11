// Ephemeral references, independent of telemetry. No questions, names, tool
// arguments, returned values, document text, prices or credentials are retained.
import { SYSTEM_BY_KEY, SYSTEM_SECTIONS } from "./system-registry.ts";
import type { CallRecord } from "./facts.ts";
import type { AgentDataSource } from "./types.ts";

export type ConversationReference = {
  section: string; id: string; version?: string;
  access: { all: string[]; any: string[] };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,120}$/;
const PERMISSIONS = new Set(["agent.use", "documents.drive.view", "documents.drive.text.view", "prices.purchase.view",
  ...SYSTEM_SECTIONS.flatMap(s => [...s.permissions, ...s.anyPermissions])]);

function clean(ref: ConversationReference): ConversationReference | null {
  const drive = ref.section === "drive" || ref.section === "drive_text";
  const section = SYSTEM_BY_KEY.get(ref.section);
  // RPC-only domains cannot prove individual row visibility; do not remember them.
  if (!drive && (!section || section.rpc || section.idColumn !== "id")) return null;
  if (!(drive ? DRIVE_ID : UUID).test(ref.id)) return null;
  if (!ref.access || ![...ref.access.all, ...ref.access.any].every(c => PERMISSIONS.has(c))) return null;
  const version = drive && ref.version && Number.isFinite(Date.parse(ref.version)) ? new Date(ref.version).toISOString() : undefined;
  if (ref.section === "drive_text" && !version) return null;
  return { section: ref.section, id: ref.id, ...(version ? { version } : {}),
    access: { all: [...new Set(["agent.use", ...ref.access.all, ...(drive ? ["documents.view", "documents.drive.view"] : section!.permissions), ...(ref.section === "drive_text" ? ["documents.drive.text.view", "prices.purchase.view"] : [])])], any: [...ref.access.any] } };
}

/** Only server-validated row references, never a model's requested ID or query. */
export function referencesFromCalls(calls: Iterable<CallRecord>): ConversationReference[] {
  const refs: ConversationReference[] = [];
  for (const call of calls) {
    if (!call.access) continue;
    for (const row of call.result.rows) {
      const entity = row.entity;
      if (!entity) continue;
      const section = entity.type === "drive" ? (call.records?.section ?? "drive") : entity.type === "system" ? entity.section
        : ({ shipment: "shipments", document: "documents", task: "tasks" } as const)[entity.type];
      if (!section) continue;
      const ref = clean({ section, id: entity.id, access: call.access, version: call.records?.versions?.[entity.id] });
      if (ref) refs.push(ref);
    }
  }
  return refs.slice(-20);
}

export async function visibleReferences(refs: ConversationReference[], data: AgentDataSource,
  permissions: (codes: readonly string[]) => Promise<ReadonlySet<string>>, signal: AbortSignal): Promise<ConversationReference[]> {
  if (!refs.length) return [];
  const visible: ConversationReference[] = [];
  for (const ref of refs) {
    try {
      if (await data.verifySystemAccess([{ section: ref.section, ids: [ref.id], ...(ref.version ? { versions: { [ref.id]: ref.version } } : {}) }], signal)) visible.push(ref);
    } catch { signal.throwIfAborted(); }
  }
  const held = await permissions([...new Set(["agent.use", ...visible.flatMap(r => [...r.access.all, ...r.access.any])])]);
  return visible.filter(r => r.access.all.every(c => held.has(c)) && (!r.access.any.length || r.access.any.some(c => held.has(c))));
}

export class ConversationMemory {
  private entries = new Map<string, { expires: number; turns: ConversationReference[][] }>();
  read(key: string, now = Date.now()): ConversationReference[] {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= now) { this.entries.delete(key); return []; }
    const unique = new Map<string, ConversationReference>();
    for (const ref of entry.turns.flat()) {
      const identity = `${ref.section}:${ref.id}`;
      unique.delete(identity); unique.set(identity, ref);
    }
    return structuredClone([...unique.values()].slice(-20));
  }
  clear(key: string): void { this.entries.delete(key); }
  append(key: string, references: ConversationReference[], now = Date.now()): void {
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    const safe = references.map(clean).filter((r): r is ConversationReference => r !== null).slice(-20);
    if (!safe.length) return;
    const turns = [...(this.entries.get(key)?.turns ?? []), safe].slice(-4);
    this.entries.delete(key);
    if (this.entries.size >= 500) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: now + 30 * 60_000, turns });
  }
}
export const conversationMemory = new ConversationMemory();
