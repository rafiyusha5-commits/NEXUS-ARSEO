// Regrade by expiry (202611280800): what batch_expiry_regrades returns. Rendering only.
export type Regrade = {
  id: string; number: string; status: "posted" | "cancelled"; quantity: string; uom: string; from_batch_id: string; from_expiry: string;
  to_batch_id: string; to_expiry: string; new_batch: boolean; warehouse: string; location: string | null; reason: string;
  created_by: string | null; created_at: string; cancelled_at: string | null; cancel_reason: string | null; direction: "out" | "in";
};
export type BatchRegrades = { can_regrade: boolean; regrades: Regrade[] };
export type RegradeBalance = { id: string; warehouse: string; location: string | null; uom: string; on_hand: number; reserved: number };
