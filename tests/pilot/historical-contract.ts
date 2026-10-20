export type Checkpoint = { stage: string; stock: Record<string, number>; reserved: number; movements: number; receipt_count: number };
// Assertions for the inherited synthetic pilot, not a replacement inventory calculation.
export function checkpointProblems(rows: Checkpoint[]): string[] {
  const expected = [
    ["received", 147, 0, 0, 3], ["reserved", 147, 0, 70, 3],
    ["transferred", 147, 0, 70, 5], ["shipped", 77, 0, 0, 7],
    ["returned", 77, 1, 0, 8], ["closed", 77, 1, 0, 8],
  ] as const;
  if (rows.length !== expected.length) return ["Incomplete checkpoint set"];
  return expected.flatMap(([stage, pieces, boxes, reserved, movements], index) => {
    const r = rows[index];
    return r.stage === stage && r.stock.piece === pieces && (r.stock.box ?? 0) === boxes &&
      r.reserved === reserved && r.movements === movements && r.receipt_count === 2
      ? [] : [`Checkpoint ${stage} does not match expected synthetic totals`];
  });
}
