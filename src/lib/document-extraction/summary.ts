// One wording for the result of a recognition run, shared by the server action, the API route
// consumer and the bulk upload. Pure: safe to import from client components.

export type ExtractionSummaryCounts = {
  ready: number;
  review: number;
  failed: number;
  processing?: number;
  deferred?: number;
  reused?: number;
};

export function describeExtractionSummary(summary: ExtractionSummaryCounts) {
  const parts = [
    `Готово к проверке: ${summary.ready}`,
    `нужна проверка: ${summary.review}`,
    `не прочитано: ${summary.failed}`,
  ];
  if (summary.processing) parts.push(`обрабатывается: ${summary.processing}`);
  if (summary.deferred) parts.push(`ожидает следующего запуска: ${summary.deferred}`);
  if (summary.reused) parts.push(`уже распознано ранее: ${summary.reused}`);
  return `${parts.join("; ")}. Данные попадут в поставку только после вашего подтверждения.`;
}
