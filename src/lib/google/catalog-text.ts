import { maskOutgoing } from "../agent/masking.ts";
export const MAX_CATALOG_TEXT = 60000;
export const CONTENT_STATUS: Record<string,string> = { pending:"Текст ещё не обработан", readable:"Текстовый слой прочитан", needs_ocr:"Нужен OCR: текстового слоя нет", unsupported:"Формат не поддерживается", error:"Не удалось прочитать текст", changed:"Файл изменился: требуется обновление", too_large:"Файл превышает лимит извлечения текста" };
export function catalogText(raw: string): { text: string; truncated: boolean } {
  const masked = maskOutgoing(raw).replace(/\r\n/g,"\n").trim();
  return { text: masked.slice(0,MAX_CATALOG_TEXT), truncated: masked.length>MAX_CATALOG_TEXT };
}
export function catalogExcerpt(text: string, query: string, limit=3000): string {
  const terms=query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term=>term.length>2);
  const lower=text.toLowerCase();
  const positions=terms.map(term=>lower.indexOf(term)).filter(index=>index>=0);
  const first=positions.length ? Math.min(...positions) : 0;
  const start=Math.max(0,first-500);
  return `${start ? "…\n" : ""}${text.slice(start,start+limit)}${start+limit<text.length ? "\n…" : ""}`;
}
/** A literal, unambiguous 'valid until' date, never inferred from a file name or an issue date. */
export function catalogExpiry(text: string): string | null {
  const dates=[...text.matchAll(/(?:действител[а-яё]*\s+до|действует\s+до|срок\s+действия[^\n]{0,160}?\s(?:до|по))\s*[:—-]?\s*(\d{1,2})[./](\d{1,2})[./](\d{4})/giu)]
    .map(match=>`${match[3]}-${match[2].padStart(2,"0")}-${match[1].padStart(2,"0")}`)
    .filter(date=>{ const parsed=new Date(date); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10)===date; });
  const unique=[...new Set(dates)];return unique.length===1 ? unique[0] : null;
}
