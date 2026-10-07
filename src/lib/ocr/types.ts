// OCR provider abstraction. Business logic (classification, field rules, review, idempotency) talks
// only to these types, so a provider can be replaced by another implementation without touching it.

export type OcrFileKind = "pdf" | "jpeg" | "png";

export type OcrInput = {
  bytes: Uint8Array;
  kind: OcrFileKind;
  mimeType: string;
  /** Pages the provider is allowed to read (already validated against the configured limit). */
  maxPages: number;
  languageHints: string[];
};

export type OcrWord = { text: string; confidence: number };

export type OcrResult = {
  text: string;
  /** Pages actually read. */
  pageCount: number;
  /** Mean confidence 0..1 over the whole document when the provider reports it. */
  confidence: number | null;
  /** Word-level confidences used to score extracted fields. May be empty. */
  words: OcrWord[];
};

export type OcrErrorCode =
  | "disabled" // no provider configured: nothing is sent anywhere
  | "unsupported" // format the provider path does not handle
  | "too_large"
  | "too_many_pages"
  | "invalid_file"
  | "timeout"
  | "provider_error" // provider replied with an error or an unusable body
  | "empty"; // provider read the file but found no text

/** Errors carry a user-safe Russian message. Raw provider bodies are never exposed. */
export class OcrError extends Error {
  readonly code: OcrErrorCode;
  /** Whether trying again can help (timeouts, provider outages) as opposed to a bad file. */
  readonly retryable: boolean;
  constructor(code: OcrErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "OcrError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface OcrProvider {
  /** Stable short id stored with every result, e.g. "google_vision". */
  readonly id: string;
  /** Version of the integration and engine; a change makes stored results eligible for re-recognition. */
  readonly version: string;
  recognize(input: OcrInput, options: { signal: AbortSignal }): Promise<OcrResult>;
}

export type OcrLimits = {
  maxFileBytes: number;
  maxPages: number;
  /** Width × height in pixels for images. */
  maxPixels: number;
  timeoutMs: number;
  /** Documents sent to the provider in one recognition run. */
  maxDocumentsPerRun: number;
  /** Attempts for one document version + provider version before it needs a reviewer's retry. */
  maxAttempts: number;
  /** A running job older than this is considered abandoned and may be taken over. */
  leaseSeconds: number;
  /** Wall-clock budget of one recognition run; documents beyond it wait for the next run. */
  runBudgetMs: number;
};

/** Raised by the text reader for a file that has no readable text layer (scan or photo): it is a candidate for OCR. */
export class NeedsOcrError extends Error {
  readonly reason: "scan_pdf" | "image";
  constructor(reason: "scan_pdf" | "image") {
    super(reason === "scan_pdf" ? "В PDF нет текстового слоя" : "Изображение требует распознавания");
    this.name = "NeedsOcrError";
    this.reason = reason;
  }
}
