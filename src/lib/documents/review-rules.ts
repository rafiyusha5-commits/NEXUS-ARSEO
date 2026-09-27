export const DOCUMENT_REVIEW_DECISIONS = ["approved", "rejected"] as const;
export type DocumentReviewDecision = (typeof DOCUMENT_REVIEW_DECISIONS)[number];

export function canSubmitDocumentForReview(status: string, archived: boolean) {
  return !archived && (status === "uploaded" || status === "rejected");
}

export function validateDocumentDecision(decision: string, comment: string) {
  if (!DOCUMENT_REVIEW_DECISIONS.includes(decision as DocumentReviewDecision)) {
    return "Некорректное решение";
  }
  if (comment.length > 1000) return "Комментарий не должен превышать 1000 символов";
  if (decision === "rejected" && comment.trim().length < 3) {
    return "При отклонении укажите причину";
  }
  return null;
}

