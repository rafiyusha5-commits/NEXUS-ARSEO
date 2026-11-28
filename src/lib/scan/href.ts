// The lookup address of a scanned or typed code (202611280500): a GS1 code is parsed into GTIN, batch, expiry and
// quantity; the source of input (scanner, typing, camera) is kept.
import { looksLikeGs1, parseGs1 } from "./gs1.ts";

/** The lookup address for a scanned or typed code: GS1 parsed into its parts, the source of input kept. */
export function scanHref(raw: string, via: "scanner" | "manual" | "camera", target = "/m/scan") {
  const code = raw.trim();
  const params = new URLSearchParams({ via });
  const gs1 = looksLikeGs1(code) ? parseGs1(code) : null;
  if (gs1?.ok && gs1.gtin) {
    params.set("code", gs1.gtin);
    if (gs1.batch) params.set("batch", gs1.batch);
    if (gs1.expiry) params.set("expiry", gs1.expiry);
    if (gs1.quantity != null) params.set("qty", String(gs1.quantity));
  } else {
    params.set("code", code);
    if (gs1 && !gs1.ok) params.set("gs1_error", gs1.error);
  }
  return `${target}?${params.toString()}`;
}
