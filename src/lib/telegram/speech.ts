import { QuestionPreparationError } from "../agent/runner.ts";
export const SPEECH_RESERVE_MICROS = 20000;
export const MAX_VOICE_BYTES = 1024 * 1024;
export type Voice = { fileId: string; duration: number; size: number };

export function voiceInput(value: unknown): Voice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.file_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(v.file_id)
    || typeof v.duration !== "number" || !Number.isInteger(v.duration) || v.duration < 1 || v.duration > 60
    || typeof v.file_size !== "number" || !Number.isSafeInteger(v.file_size) || v.file_size < 1 || v.file_size > MAX_VOICE_BYTES) return null;
  return { fileId: v.file_id, duration: v.duration, size: v.file_size };
}

// Verify actual Ogg/Opus duration, not just Telegram's declared duration. No conversion or disk IO.
export function opusDuration(bytes: Uint8Array): number {
  const buffer = Buffer.from(bytes);
  let offset = 0; let serial: number | null = null; let granule = BigInt(0); let preSkip = 0; let ended = false;
  while (offset < buffer.length) {
    if (offset + 27 > buffer.length || buffer.toString("ascii", offset, offset + 4) !== "OggS" || buffer[offset + 4] !== 0) throw new QuestionPreparationError("VOICE_FORMAT");
    const pageSerial = buffer.readUInt32LE(offset + 14);
    if (serial !== null && serial !== pageSerial) throw new QuestionPreparationError("VOICE_FORMAT");
    serial = pageSerial;
    const segments = buffer[offset + 26];
    const body = offset + 27 + segments;
    if (body > buffer.length) throw new QuestionPreparationError("VOICE_FORMAT");
    let bodyLength = 0;
    for (let i = 0; i < segments; i++) bodyLength += buffer[offset + 27 + i];
    if (body + bodyLength > buffer.length) throw new QuestionPreparationError("VOICE_FORMAT");
    if (offset === 0) {
      if (bodyLength < 19 || buffer.toString("ascii", body, body + 8) !== "OpusHead") throw new QuestionPreparationError("VOICE_FORMAT");
      preSkip = buffer.readUInt16LE(body + 10);
    }
    const pageGranule = buffer.readBigUInt64LE(offset + 6);
    if (pageGranule !== BigInt("18446744073709551615")) granule = pageGranule;
    ended = (buffer[offset + 5] & 4) !== 0;
    offset = body + bodyLength;
    if (ended && offset !== buffer.length) throw new QuestionPreparationError("VOICE_FORMAT");
  }
  const seconds = Number(granule - BigInt(preSkip)) / 48000;
  if (!ended || seconds <= 0 || seconds > 60) throw new QuestionPreparationError("VOICE_DURATION");
  return seconds;
}

export async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new QuestionPreparationError("VOICE_DOWNLOAD");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break;
      size += value.value.byteLength;
      if (size > max) { await reader.cancel(); throw new QuestionPreparationError("VOICE_TOO_LARGE"); }
      chunks.push(value.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function transcribeVoice(bytes: Uint8Array, apiKey: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ text: string; costUsdMicros: number; durationSeconds: number }> {
  const durationSeconds = opusDuration(bytes);
  const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "gpt-4o-mini-transcribe"); form.append("response_format", "json"); form.append("language", "ru");
  form.append("prompt", "Вопрос сотрудника о поставках, загрузке, документах и товарах Nexus ARSEO. Передавайте даты, номера и названия точно.");
  let costUsdMicros = SPEECH_RESERVE_MICROS;
  try {
    const response = await fetcher("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    });
    if (!response.ok) throw new QuestionPreparationError("VOICE_PROVIDER", response.status >= 400 && response.status < 500 ? 0 : costUsdMicros);
    const bytes = await readBounded(response, 32000);
    const result = JSON.parse(Buffer.from(bytes).toString("utf8")) as { text?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const input = Number(result.usage?.input_tokens); const output = Number(result.usage?.output_tokens);
    // Audio/text input $1.25/M and text output $5/M. Missing usage is charged conservatively.
    if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) costUsdMicros = Math.ceil(input * 1.25 + output * 5);
    if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 2000) throw new QuestionPreparationError("VOICE_EMPTY", costUsdMicros);
    return { text: result.text.trim(), costUsdMicros, durationSeconds };
  } catch (error) {
    if (error instanceof QuestionPreparationError) throw error;
    throw new QuestionPreparationError("VOICE_PROVIDER", costUsdMicros);
  }
}
