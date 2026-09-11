import type { ProposalEntry } from "../../app/agent-session.js";
import { previewLines } from "../../app/workbook-actions.js";

export interface ChangePreviewProps {
  readonly proposal: ProposalEntry;
  readonly busy: boolean;
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
}

const STATE_LABEL: Record<ProposalEntry["state"], string> = {
  pending: "Proposed change",
  applying: "Applying…",
  applied: "✓ Applied",
  rejected: "Rejected",
  failed: "✕ Failed",
};

export function ChangePreview({ proposal, busy, onApprove, onReject }: ChangePreviewProps) {
  return (
    <section className={`term-change term-change--${proposal.state}`} aria-label="Proposed workbook change">
      <div className="term-change-head">{STATE_LABEL[proposal.state]}</div>
      {proposal.sheetOp?.kind === "create_sheet" && (
        <div className="term-change-action">
          <div className="term-change-desc">Create worksheet “{proposal.sheetOp.name}”</div>
          <div className="term-change-line">A new empty sheet is added; Undo removes it.</div>
        </div>
      )}
      {proposal.actions.map((action) => (
        <div key={action.id} className="term-change-action">
          <div className="term-change-desc">{action.description}</div>
          {previewLines(action).map((line, index) => (
            <div key={index} className="term-change-line">
              {line}
            </div>
          ))}
        </div>
      ))}
      {proposal.note && <div className="term-change-note">{proposal.note}</div>}
      {proposal.state === "pending" && (
        <div className="term-change-actions">
          <button type="button" className="term-btn term-btn--primary" disabled={busy} onClick={() => onApprove(proposal.id)}>
            Approve
          </button>
          <button type="button" className="term-btn" disabled={busy} onClick={() => onReject(proposal.id)}>
            Reject
          </button>
        </div>
      )}
    </section>
  );
}
