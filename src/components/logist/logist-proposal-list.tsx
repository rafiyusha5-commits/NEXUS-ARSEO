import Link from "next/link";
import { acceptLogistProposalAction, rejectLogistProposalAction } from "@/app/logist/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { ACCEPT_EFFECT, KIND_LABEL, type LogistProposal } from "@/lib/logist/proposals";

const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

// Pending proposals with «Принять» and «Отклонить». Who may decide is checked by the database for every kind.
export function LogistProposalList({ proposals, back, showShipment = false }: { proposals: LogistProposal[]; back: string; showShipment?: boolean }) {
  return <ul className="logist-list">{proposals.map(proposal => <li key={proposal.id} className={`logist-proposal logist-${proposal.kind}`}>
    <div className="logist-proposal-head">
      <span className="logist-kind">{KIND_LABEL[proposal.kind] ?? proposal.kind}</span>
      {showShipment && <Link href={`/shipments/${proposal.shipment_id}`}>{proposal.shipment?.shipment_number ?? "Поставка"}</Link>}
      <time dateTime={proposal.created_at}>{dateTime(proposal.created_at)}</time>
    </div>
    <strong>{proposal.title}</strong>
    <p>{proposal.reason}</p>
    <small>{ACCEPT_EFFECT[proposal.kind]}</small>
    <div className="logist-actions">
      <form action={acceptLogistProposalAction}>
        <input type="hidden" name="proposal_id" value={proposal.id}/><input type="hidden" name="shipment_id" value={proposal.shipment_id}/><input type="hidden" name="back" value={back}/>
        <PendingSubmitButton className="primary compact" pendingText="Выполняем…">Принять</PendingSubmitButton>
      </form>
      <form action={rejectLogistProposalAction} className="logist-reject">
        <input type="hidden" name="proposal_id" value={proposal.id}/><input type="hidden" name="shipment_id" value={proposal.shipment_id}/><input type="hidden" name="back" value={back}/>
        <input name="note" maxLength={500} placeholder="Почему отклоняете (необязательно)" aria-label={`Причина отклонения: ${proposal.title}`}/>
        <PendingSubmitButton className="ghost compact" pendingText="Отклоняем…">Отклонить</PendingSubmitButton>
      </form>
    </div>
  </li>)}</ul>;
}
