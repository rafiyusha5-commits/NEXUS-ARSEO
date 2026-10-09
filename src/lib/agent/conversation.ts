// Process-local hints only: no answers, tool results, files or credentials are retained.
// Restarts clear the context. Scope includes employee, channel and conversation/chat.
import { maskOutgoing, prepareQuestion } from "./masking.ts";
export class ConversationMemory {
  private entries = new Map<string, { expires: number; turns: string[] }>();
  read(key: string, now = Date.now()): string[] {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= now) { this.entries.delete(key); return []; }
    return [...entry.turns];
  }
  clear(key: string): void { this.entries.delete(key); }
  append(key: string, question: string, hints: string, now = Date.now()): void {
    const safe = prepareQuestion(question);
    if (!safe.ok) return;
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    const turns = [...this.read(key, now), JSON.stringify({ question: safe.text, searchHints: maskOutgoing(hints).slice(0, 600) })].slice(-4);
    this.entries.delete(key);
    if (this.entries.size >= 500) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: now + 30 * 60_000, turns });
  }
}
export const conversationMemory = new ConversationMemory();
