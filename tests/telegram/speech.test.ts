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
  it("accepts complete short Telegram pages without EOS while retaining the duration and truncation checks", () => {
    const open = Buffer.from(ogg(4)); open[47 + 5] = 0;
    assert.equal(opusDuration(open), 4);
    const partial = Buffer.concat([open.subarray(0, 75), Buffer.alloc(255)]); partial[74] = 255;
    assert.throws(() => opusDuration(partial), { message: "VOICE_FORMAT" });
    assert.throws(() => opusDuration(open.subarray(0, open.length - 1)));
    const long = Buffer.from(ogg(61)); long[47 + 5] = 0;
    assert.throws(() => opusDuration(long), { message: "VOICE_DURATION" });
    const empty = Buffer.from(ogg(0)); empty[47 + 5] = 0;
    assert.throws(() => opusDuration(empty), { message: "VOICE_DURATION" });
  });
  it("transcribes Ogg in memory and includes returned token usage in money accounting", async () => {
    const fetcher = (async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/audio/transcriptions"); assert.equal(options?.redirect, "error");
      const form = options?.body as FormData; assert.equal(form.get("model"), "gpt-4o-mini-transcribe"); assert.ok(form.get("file") instanceof Blob);
      return Response.json({ text: "Все о поставке 15.10", usage: { input_tokens: 100, output_tokens: 20 } });
    }) as typeof fetch;
    assert.deepEqual(await transcribeVoice(ogg(9), "secret", new AbortController().signal, fetcher), { text: "Все о поставке 15.10", costUsdMicros: 225, durationSeconds: 9 });
  });
  it("charges the speech reservation whenever the provider may have billed without reporting usage", async () => {
    const cost = async (response: Response | Error) => {
      const fetcher = (async () => { if (response instanceof Error) throw response; return response; }) as typeof fetch;
      return transcribeVoice(ogg(9), "secret", new AbortController().signal, fetcher).then(() => -1, (error: { costUsdMicros: number }) => error.costUsdMicros);
    };
    assert.equal(await cost(new Error("timeout")), 20000, "lost connection: unknown, charged");
    assert.equal(await cost(new Response("busy", { status: 503 })), 20000, "5xx: unknown, charged");
    assert.equal(await cost(new Response("x".repeat(40_000))), 20000, "oversized answer after billing: charged, not released");
    assert.equal(await cost(new Response("{broken")), 20000, "unreadable answer: charged");
    assert.equal(await cost(Response.json({ error: "bad audio" }, { status: 400 })), 0, "a refused request is not billed");
    assert.equal(await cost(Response.json({ text: "", usage: { input_tokens: 100, output_tokens: 0 } })), 125, "empty text with usage: the reported cost");
    // Invalid audio is refused before anything is sent.
    await assert.rejects(transcribeVoice(Buffer.from("not audio"), "secret", new AbortController().signal, (async () => { throw new Error("must not be called"); }) as typeof fetch), { costUsdMicros: 0 });
  });

  it("never leaks provider keys in errors and bounds downloads", async () => {
    const fetcher = (async () => { throw new Error("secret token URL"); }) as typeof fetch;
    await assert.rejects(transcribeVoice(ogg(9), "secret", new AbortController().signal, fetcher), { message: "VOICE_PROVIDER", costUsdMicros: 20000 });
    await assert.rejects(readBounded(new Response("123456"), 3), { message: "VOICE_TOO_LARGE" });
  });
});
