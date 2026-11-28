import { useEffect, useState } from 'react';
import type {
  PilotDeskOffering,
  PilotQueueEntry,
  PilotValidationResult,
} from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message } from '../../api.js';
import { date } from '../../format.js';
import { Alert, Empty, Panel } from '../../ui.js';
import { offeringLabel } from './shared.js';

/** Exam-section validation under a delegation: staff record a report, never marks. */
export function ExamOffice({ api, offerings }: { api: Api; offerings: PilotDeskOffering[] }) {
  const names = new Map(offerings.map((o) => [o.offeringId, offeringLabel(o)]));
  const [queue, setQueue] = useState<PilotQueueEntry[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      setQueue((await api<{ batches: PilotQueueEntry[] }>('/pilot/validation-queue')).batches);
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function validate(entry: PilotQueueEntry) {
    setBusy(entry.batchId);
    setError('');
    try {
      const note = notes[entry.batchId]?.trim();
      const result = await api<PilotValidationResult>(
        `/pilot/batches/${entry.batchId}/validate`,
        note ? { note } : {},
      );
      setNotice(
        `Validated ${names.get(entry.offeringId) ?? 'the batch'} ${entry.stage.toUpperCase()} revision ${entry.revisionNo}: ${result.missingRows} enrolled students have no row.`,
      );
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <Panel
      title="Submitted revisions to validate"
      subtitle="Check each submitted revision against the roster under your delegation. Validation records missing rows; it never changes marks."
    >
      {error && <Alert>{error}</Alert>}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {queue === null && !error && <p role="status">Loading the validation queue…</p>}
      {queue?.length === 0 && (
        <Empty title="Nothing to validate">No submitted revisions are waiting.</Empty>
      )}
      {!!queue?.length && (
        <ul className="pilot-queue">
          {queue.map((entry) => (
            <li key={entry.batchId}>
              <span>
                <strong>{names.get(entry.offeringId) ?? entry.offeringId}</strong> ·{' '}
                {entry.stage.toUpperCase()} revision {entry.revisionNo}
              </span>
              <span>Submitted {date(entry.submittedAt)}</span>
              <input
                aria-label={`Validation note for ${names.get(entry.offeringId) ?? entry.offeringId} ${entry.stage}`}
                placeholder="Optional note"
                maxLength={500}
                value={notes[entry.batchId] ?? ''}
                onChange={(e) => setNotes((all) => ({ ...all, [entry.batchId]: e.target.value }))}
              />
              <button
                className="primary"
                disabled={busy === entry.batchId}
                onClick={() => void validate(entry)}
              >
                Record validation
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
