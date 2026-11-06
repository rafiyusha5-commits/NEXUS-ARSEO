import Link from "next/link";
import type { DocumentActionInfo } from "@/lib/documents/action-index";

export function DocumentActions({ document, version, fileId, hideCard = false, reviewOnly = false }: {
  document?: DocumentActionInfo; version?: number | null; fileId?: string; hideCard?: boolean; reviewOnly?: boolean;
}) {
  if (!document) return null;
  const number = version === undefined ? document.current : version;
  const file = fileId ? Object.values(document.files).find(id => id === fileId) : number === null ? undefined : document.files[number];
  const reviews = file && file === document.files[document.current] ? document.reviews : [];
  if (reviewOnly && !reviews.length) return null;
  const card = `/documents/${document.id}`;
  return <span className="document-actions">
    {!reviewOnly && !hideCard && <Link href={card}>Открыть карточку</Link>}
    {!reviewOnly && file && <a href={`${card}/download?version=${file}`}>Скачать оригинал</a>}
    {reviews.map(review => <a key={review.href} href={review.href}>Посмотреть поля сверки{reviews.length > 1 ? ` · ${review.shipment}` : ""}</a>)}
  </span>;
}
