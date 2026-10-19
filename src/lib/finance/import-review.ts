export type ImportPayload = {
  kind: "bank" | "opening"; file_name: string; file_sha256: string;
  rows: Record<string, unknown>[]; problems: string[];
  currency?: string; account?: string; period_from?: string | null; period_to?: string | null; as_of?: string;
  excluded?: { rowNumber: number; name: string; reason: string }[];
};
export type ImportReview = {
  fingerprint: string; can_confirm: boolean; existing_batch_id: string | null;
  totals: { currency: string; count: number; amount: number }[];
  rows: { ordinal: number; status: "new" | "duplicate" | "error"; problem: string | null;
    amount: number; currency: string; customer_name: string | null; match_reason: string | null;
    previous_balance: { id: string; amount: number; as_of: string } | null;
    legacy_candidates: { id: string; number: string; date: string; amount: number }[] }[];
};
