import type {
  PilotBatchSummary,
  PilotDeskOffering,
  PilotRoster,
  PilotScore,
} from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { Badge } from '../../ui.js';

export const offeringLabel = (offering: PilotDeskOffering) =>
  `${offering.courseCode} · ${offering.sectionCode}`;

export const newKey = () => crypto.randomUUID();

/** Every enrolled student of an offering in USN order, following the roster pages. */
export async function fullRoster(api: Api, offeringId: string) {
  const students: PilotRoster['students'] = [];
  let after: string | null = null;
  do {
    const page: PilotRoster = await api<PilotRoster>(
      `/pilot/offerings/${offeringId}/roster${after ? `?after=${after}` : ''}`,
    );
    students.push(...page.students);
    after = page.nextAfter;
  } while (after);
  return students.sort((a, b) => a.studentCode.localeCompare(b.studentCode));
}

/** The workflow state of a marks revision, as a short badge. */
export function BatchState({ batch }: { batch: PilotBatchSummary | undefined }) {
  if (!batch) return <Badge>No revision yet</Badge>;
  const revision = `Revision ${batch.revisionNo}`;
  if (batch.review?.verdict === 'approved')
    return <Badge tone="green">{revision} · approved</Badge>;
  if (batch.review?.verdict === 'returned') return <Badge tone="red">{revision} · returned</Badge>;
  if (batch.submittedAt) return <Badge tone="amber">{revision} · submitted</Badge>;
  return <Badge>{revision} · draft</Badge>;
}

export function Score({ label, score }: { label: string; score: PilotScore | null | undefined }) {
  return (
    <div className="pilot-score">
      <span>{label}</span>
      <strong>{score ? `${score.marks} / ${score.maximum}` : '—'}</strong>
      <small>{score ? `${score.percent}%` : ''}</small>
    </div>
  );
}

export function OfferingPicker({
  offerings,
  value,
  onChange,
  label = 'Offering',
}: {
  offerings: PilotDeskOffering[];
  value: string;
  onChange: (offeringId: string) => void;
  label?: string;
}) {
  return (
    <div className="field pilot-picker">
      <label htmlFor="pilot-offering">{label}</label>
      <select id="pilot-offering" value={value} onChange={(e) => onChange(e.target.value)}>
        {offerings.map((o) => (
          <option key={o.offeringId} value={o.offeringId}>
            {offeringLabel(o)} ({o.termCode})
          </option>
        ))}
      </select>
    </div>
  );
}
