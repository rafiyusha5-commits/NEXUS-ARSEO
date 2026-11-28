// Telling a hardware scanner (a Bluetooth or USB scanner working as a keyboard) from a person typing: the scanner sends
// the whole code within milliseconds and ends with Enter. Only the timing is used; the code itself is not judged.

export type KeyStroke = { key: string; at: number };
export type InputSource = "scanner" | "manual";

/** At least 4 characters, ended by Enter, and the median gap between them under 35 ms. */
export function inputSource(strokes: KeyStroke[]): InputSource {
  const chars = strokes.filter(stroke => stroke.key.length === 1);
  const ended = strokes.at(-1)?.key === "Enter";
  if (!ended || chars.length < 4) return "manual";
  const gaps = chars.slice(1).map((stroke, index) => stroke.at - chars[index].at).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median < 35 ? "scanner" : "manual";
}
