import { useEffect, useState } from 'react';
import type {
  PilotBatch,
  PilotBatchValidation,
  PilotDeskOffering,
  PilotQueueEntry,
} from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message } from '../../api.js';
import { date } from '../../format.js';
import { Alert, Empty, Field, Panel } from '../../ui.js';
import { offeringLabel } from './shared.js';

type Entry = PilotQueueEntry & { authorSubject: string; validation: PilotBatchValidation | null };

export function DepartmentReview({ api, offerings }: { api: Api; offerings: PilotDeskOffering[] }) {
  const names = new Map(offerings.map((o) => [o.offeringId, offeringLabel(o)]));
  const [queue, setQueue] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<PilotBatch | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      setQueue((await api<{ batches: Entry[] }>('/pilot/review-queue')).batches);
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function show(batchId: string) {
    setError('');
    setNotice('');
    setReason('');
    try {
      setOpen(await api<PilotBatch>(`/pilot/batches/${batchId}`));
    } catch (e) {
      setError(message(e));
    }
  }

  async function decide(verdict: 'approved' | 'returned') {
    if (!open) return;
    setBusy(true);
    setError('');
    try {
      await api(`/pilot/batches/${open.batchId}/review`, {
        verdict,
        ...(verdict === 'returned' ? { reason: reason.trim() } : {}),
      });
      setNotice(
        verdict === 'approved'
          ? `Approved revision ${open.revisionNo}. It is now locked for publication.`
          : `Returned revision ${open.revisionNo} to ${open.authorSubject}.`,
      );
      setOpen(null);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel
        title="CIE revisions awaiting review"
        subtitle="Approve a submitted revision or return it with a reason. Your own revisions never appear here."
      >
        {error && <Alert>{error}</Alert>}
        {notice && (
          <div className="success" role="status">
            {notice}
          </div>
        )}
        {queue === null && !error && <p role="status">Loading the review queue…</p>}
        {queue?.length === 0 && (
          <Empty title="Nothing to review">No submitted CIE revisions are waiting.</Empty>
        )}
        {!!queue?.length && (
          <ul className="pilot-queue">
            {queue.map((entry) => (
              <li key={entry.batchId} aria-current={open?.batchId === entry.batchId || undefined}>
                <span>
                  <strong>{names.get(entry.offeringId) ?? entry.offeringId}</strong> · revision{' '}
                  {entry.revisionNo} by {entry.authorSubject}
                </span>
                <span>
                  Submitted {date(entry.submittedAt)}
                  {entry.validation
                    ? ` · validated, ${entry.validation.missingRows} missing rows`
                    : ' · not validated'}
                </span>
                <button className="secondary" onClick={() => void show(entry.batchId)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {open && (
        <Panel
          title={`${names.get(open.offeringId) ?? 'Offering'} · CIE revision ${open.revisionNo}`}
          subtitle={`Entered by ${open.authorSubject}. Policy ${open.policy.id} v${open.policy.version}.`}
        >
          <div
            className="table-scroll pilot-grid"
            role="region"
            aria-label="Submitted marks"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  {open.components.map((code) => (
                    <th key={code}>{code}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.rows.map((row) => (
                  <tr key={row.enrolmentId}>
                    <td>{row.studentCode}</td>
                    {row.values.map((value, i) => (
                      <td key={open.components[i]}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pilot-actions">
            <button className="primary" disabled={busy} onClick={() => void decide('approved')}>
              Approve revision
            </button>
            <Field label="Reason for returning">
              <textarea
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <button
              className="secondary"
              disabled={busy || !reason.trim()}
              onClick={() => void decide('returned')}
            >
              Return with reason
            </button>
          </div>
        </Panel>
      )}
    </>
  );
}
