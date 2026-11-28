import Link from "next/link";
import { ScanFeedback } from "@/components/scan-feedback";
import { ScanField } from "@/components/scan-field";
import { requirePageUser } from "@/lib/auth/access";
import { gs1ErrorText, type Gs1Result } from "@/lib/scan/gs1";
import { type ScanResult } from "@/lib/scan/lookup";
import { ScanResultView } from "@/components/scan-result";
import { bindScanCode } from "./actions";

type Search = { code?: string; batch?: string; expiry?: string; qty?: string; via?: string; gs1_error?: string; error?: string; success?: string };

// Lookup by code (202611280500): what the code is, where it is, how much is free, the expiry. Reading only; cost with
// purchase prices (the database decides). An unknown code can be bound to a product with products.update.
export default async function MobileScanPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const { supabase } = await requirePageUser();
  const code = (params.code ?? "").trim().slice(0, 200);
  const gs1Error = params.gs1_error && params.gs1_error in gs1ErrorText ? gs1ErrorText[params.gs1_error as Exclude<Gs1Result, { ok: true }>["error"]] : null;
  const lookup = code && !gs1Error ? await supabase.rpc("scan_lookup", { p_code: code, p_batch_number: params.batch?.slice(0, 40) || null }) : null;
  const result = lookup?.data as ScanResult | null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  return <>
    <h1 className="mobile-title">Поиск по коду</h1>
    <ScanField/>
    {params.error && <div className="login-error admin-message">{params.error}</div>}{params.success && <div className="login-success admin-message">{params.success}</div>}
    {gs1Error && <><ScanFeedback ok={false} signature={code}/><section className="mobile-card mobile-card-warning"><strong>{gs1Error}</strong><small>Код не разобран — проверьте этикетку или введите GTIN вручную.</small></section></>}
    {lookup?.error && <section className="mobile-card mobile-card-warning"><strong>Поиск недоступен</strong><small>Нужно право на остатки или на товары.</small></section>}
    {result && <ScanResultView result={result} today={today} params={params} bindAction={bindScanCode}/>}
    {!code && <p className="mobile-hint">Сканер Bluetooth работает как клавиатура: курсор в поле, сканируйте — поиск откроется сам. Поиск ничего не записывает.</p>}
    <p><Link href="/m">← Склад</Link></p>
  </>;
}
