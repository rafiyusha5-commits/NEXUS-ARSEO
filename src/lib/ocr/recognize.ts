// Turns an OCR text into a *proposal*: the same field rules as for text documents, but with a
// per-field confidence that combines the rule confidence and the OCR confidence of the words the
// value was read from. Nothing here writes anywhere; the proposal always goes to employee review.

import { detectShipmentSourceKind, extractShipmentFields, type ExtractionResult } from "../document-extraction/rules.ts";
import type { OcrResult, OcrWord } from "./types.ts";

/** Fields below this confidence are flagged for a closer look; the whole document needs review if any is. */
export const LOW_CONFIDENCE = 0.8;

const normalize = (value: string) => value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
const round = (value: number) => Math.round(value * 100) / 100;

/** Mean OCR confidence of the words that make up `value`; null when none of them can be found. */
export function valueConfidence(value: string, words: OcrWord[]) {
  const tokens = value.split(/\s+/).map(normalize).filter(Boolean);
  if (!tokens.length || !words.length) return null;
  const pool = new Map<string, number[]>();
  for (const word of words) {
    const key = normalize(word.text);
    if (key) pool.set(key, [...(pool.get(key) ?? []), word.confidence]);
  }
  const found: number[] = [];
  for (const token of tokens) {
    const list = pool.get(token);
    if (list?.length) found.push(list.reduce((sum, item) => sum + item, 0) / list.length);
  }
  return found.length ? found.reduce((sum, item) => sum + item, 0) / found.length : null;
}

export type OcrProposal = {
  sourceKind: string;
  result: ExtractionResult;
  status: "extracted" | "needs_review" | "failed";
  /** Fields whose confidence is below LOW_CONFIDENCE. */
  lowConfidence: string[];
  confidence: number | null;
  error: string | null;
};

export function proposeFromOcr(ocr: OcrResult, hintedKind: string): OcrProposal {
  const result = extractShipmentFields(ocr.text, { fromOcr: true });
  const sourceKind = detectShipmentSourceKind(ocr.text, hintedKind);
  const documentConfidence = ocr.confidence;
  const lowConfidence: string[] = [];
  for (const [field, evidence] of Object.entries(result.evidence)) {
    const measured = valueConfidence(evidence.value, ocr.words);
    // A text read from a picture can never be more certain than the pattern that found it, nor than the engine's own score.
    const base = measured ?? documentConfidence ?? 0.6;
    evidence.confidence = round(Math.min(evidence.confidence, base));
    if (evidence.confidence < LOW_CONFIDENCE) lowConfidence.push(field);
  }
  if (!Object.keys(result.data).length) {
    // The employee can enter verified values through the existing review form.
    // A known document with readable text is not the same as an unreadable scan.
    if (sourceKind !== "other" && ocr.text.trim()) {
      return { sourceKind, result, status: "needs_review", lowConfidence, confidence: documentConfidence, error: "Текст прочитан, но реквизиты не найдены: проверьте оригинал и введите данные вручную" };
    }
    return { sourceKind, result, status: "failed", lowConfidence, confidence: documentConfidence, error: "Текст прочитан, но реквизиты не найдены: проверьте качество скана или введите данные вручную" };
  }
  const uncertain = lowConfidence.length > 0 || (documentConfidence !== null && documentConfidence < LOW_CONFIDENCE);
  return { sourceKind, result, status: uncertain ? "needs_review" : "extracted", lowConfidence, confidence: documentConfidence, error: null };
}
