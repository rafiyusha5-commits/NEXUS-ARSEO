// The lookup address of a scanned or typed code (202611280500): a GS1 code is parsed into GTIN, batch, expiry and
// quantity; the source of input (scanner, typing, camera) is kept.
import { looksLikeGs1, parseGs1 } from "./gs1.ts";

/** The lookup address for a scanned or typed code: GS1 parsed into its parts, the source of input kept. A target with its
 *  own query (an operation in progress: the order, the place being counted) keeps it; the parts of the last scan replace
 *  those of the previous one. */
export function scanHref(raw: string, via: "scanner" | "manual" | "camera", target = "/m/scan") {
  const code = raw.trim();
  const [path, query = ""] = target.split("?", 2);
  const params = new URLSearchParams(query);
  for (const key of ["via", "code", "batch", "expiry", "qty", "gs1_error", "error", "success"]) params.delete(key);
  params.set("via", via);
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
  return `${path}?${params.toString()}`;
}
