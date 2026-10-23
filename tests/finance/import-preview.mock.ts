import type { ImportPayload, ImportReview } from "../../src/lib/finance/import-review";
export async function previewImport(p: ImportPayload) {
  const row=p.rows[0], ok=Boolean(row.operation_id && row.reason);
  const review: ImportReview={ fingerprint:JSON.stringify(row),can_confirm:ok,existing_batch_id:null,
    totals:[{currency:"KZT",count:1,amount:1234.56}],
    rows:[{ordinal:1,status:ok?"new":"error",problem:ok?null:"Нужен устойчивый идентификатор операции из банка",amount:1234.56,currency:"KZT",
      customer_name:'Синтетический <img src=x onerror=alert(1)>',match_reason:"auto_bin",previous_balance:null,legacy_candidates:[]}] };
  return {review};
}
export async function confirmImport() { return {message:"Синтетический пакет подтверждён один раз"}; }
