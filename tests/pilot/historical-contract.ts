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

// Readiness must require actual UI-to-database evidence, not just successful SQL/component tests.
export function browserEvidenceProblems(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["Missing authenticated browser evidence"];
  const report = value as Record<string, unknown>;
  const required = ["fullBrowserE2E", "twoTabWrites", "manualConfirmationsPreserved", "fourDocumentTypesParsed",
    "missingSecondCmrDetected", "bothCmrsPresent", "permissionBoundary", "ocrIndicator"];
  const problems = required.filter(key => report[key] !== true).map(key => `Missing browser proof: ${key}`);
  if (!Array.isArray(report.checkpoints) || report.checkpoints.some(row => !row || typeof row !== "object" || !row.stock))
    problems.push("Missing UI-to-database checkpoints");
  else problems.push(...checkpointProblems(report.checkpoints.map(row => ({ ...row, receipt_count: row.receipts }))));
  const cost = report.cost as Record<string, unknown> | undefined;
  if (!cost || cost.goods !== 346 || cost.expenses !== 50 || cost.total !== 396 || cost.status !== "approved")
    problems.push("Missing approved browser costing");
  const paid = report.paidQuantityRule as Record<string, unknown> | undefined;
  if (!paid || paid.goods !== 1000 || paid.received !== 98 || paid.basis !== 100 || paid.unitCost !== 10)
    problems.push("Paid 100 / received 98 rule was not verified through forms");
  return problems;
}
