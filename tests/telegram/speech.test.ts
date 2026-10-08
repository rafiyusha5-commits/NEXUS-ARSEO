import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { opusDuration, voiceInput, transcribeVoice, readBounded } from "../../src/lib/telegram/speech.ts";
function ogg(seconds: number): Uint8Array {
  const header = Buffer.alloc(47); header.write("OggS"); header[26] = 1; header[27] = 19; header.write("OpusHead", 28); header[36] = 1; header[37] = 1;
  const end = Buffer.alloc(29); end.write("OggS"); end[5] = 4; end.writeBigUInt64LE(BigInt(seconds * 48000), 6); end[26] = 1; end[27] = 1;
  return Buffer.concat([header, end]);
}
describe("Telegram speech", () => {
  it("rejects oversized, long or malformed Telegram voice metadata before download", () => {
    const valid = { file_id: "abc_123", duration: 9, file_size: 1000 }; assert.ok(voiceInput(valid));
    for (const bad of [{ ...valid, duration: 61 }, { ...valid, file_size: 1048577 }, { ...valid, file_id: "../../secret" }, {}]) assert.equal(voiceInput(bad), null);
  });
  it("verifies actual audio duration and rejects forged metadata, chained streams and non-audio", () => {
    assert.equal(opusDuration(ogg(9)), 9); assert.throws(() => opusDuration(ogg(61))); assert.throws(() => opusDuration(Buffer.from("not audio")));
    assert.throws(() => opusDuration(Buffer.concat([ogg(1), ogg(1)])));
  });
  it("transcribes Ogg in memory and includes returned token usage in money accounting", async () => {
    const fetcher = (async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/audio/transcriptions"); assert.equal(options?.redirect, "error");
      const form = options?.body as FormData; assert.equal(form.get("model"), "gpt-4o-mini-transcribe"); assert.ok(form.get("file") instanceof Blob);
      return Response.json({ text: "Все о поставке 15.10", usage: { input_tokens: 100, output_tokens: 20 } });
    }) as typeof fetch;
    assert.deepEqual(await transcribeVoice(ogg(9), "secret", new AbortController().signal, fetcher), { text: "Все о поставке 15.10", costUsdMicros: 225, durationSeconds: 9 });
  });
  it("never leaks provider keys in errors and bounds downloads", async () => {
    const fetcher = (async () => { throw new Error("secret token URL"); }) as typeof fetch;
    await assert.rejects(transcribeVoice(ogg(9), "secret", new AbortController().signal, fetcher), { message: "VOICE_PROVIDER", costUsdMicros: 20000 });
    await assert.rejects(readBounded(new Response("123456"), 3), { message: "VOICE_TOO_LARGE" });
  });
});
