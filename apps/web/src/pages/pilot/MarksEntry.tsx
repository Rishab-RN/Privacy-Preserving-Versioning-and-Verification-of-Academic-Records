import { useEffect, useRef, useState } from 'react';
import type {
  PilotBatch,
  PilotBatchCreated,
  PilotBatchStage,
  PilotBatchSummary,
  PilotDeskOffering,
  PilotEntryForm,
  PilotRoster,
} from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message } from '../../api.js';
import { Alert, Empty, Panel } from '../../ui.js';
import { BatchState, fullRoster, newKey, offeringLabel } from './shared.js';

interface Loaded {
  form: PilotEntryForm;
  roster: PilotRoster['students'];
  head: PilotBatchSummary | undefined;
}

const stageName = (stage: PilotBatchStage) => (stage === 'cie' ? 'CIE' : 'SEE');

/** Whether an entered value is a valid mark for its maximum, or an allowed absence. */
function valid(value: string, maximum: string, absence: boolean) {
  const text = value.trim();
  if (text === '') return true;
  if (text.toUpperCase() === 'AB') return absence;
  return /^\d{1,3}(\.\d{1,2})?$/.test(text) && Number(text) <= Number(maximum);
}

export function MarksEntry({ api, offerings }: { api: Api; offerings: PilotDeskOffering[] }) {
  const choices = offerings.flatMap((offering) =>
    offering.entryStages.map((stage) => ({ offering, stage })),
  );
  const [choice, setChoice] = useState(0);
  const current = choices[Math.min(choice, choices.length - 1)];
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const key = useRef<string | null>(null);

  async function load() {
    if (!current) return;
    const { offering, stage } = current;
    setError('');
    setLoaded(null);
    try {
      const [form, roster, list] = await Promise.all([
        api<PilotEntryForm>(`/pilot/offerings/${offering.offeringId}/entry-form/${stage}`),
        fullRoster(api, offering.offeringId),
        api<{ batches: PilotBatchSummary[] }>(`/pilot/offerings/${offering.offeringId}/batches`),
      ]);
      const head = list.batches.filter((b) => b.stage === stage).at(-1);
      const filled: Record<string, string[]> = {};
      for (const student of roster) filled[student.enrolmentId] = form.components.map(() => '');
      if (head) {
        const batch = await api<PilotBatch>(`/pilot/batches/${head.batchId}`);
        for (const row of batch.rows) {
          filled[row.enrolmentId] = form.components.map((component) => {
            const index = batch.components.indexOf(component.code);
            return index < 0 ? '' : (row.values[index] ?? '');
          });
        }
      }
      setValues(filled);
      setLoaded({ form, roster, head });
      setDirty(false);
      key.current = null;
    } catch (e) {
      setError(message(e));
    }
  }

  /** After a save or submit only the head changes; the grid already holds its values. */
  async function refreshHead() {
    if (!current) return;
    const list = await api<{ batches: PilotBatchSummary[] }>(
      `/pilot/offerings/${current.offering.offeringId}/batches`,
    );
    const latest = list.batches.filter((b) => b.stage === current.stage).at(-1);
    setLoaded((state) => state && { ...state, head: latest });
    setDirty(false);
    key.current = null;
  }

  useEffect(() => {
    setNotice('');
    void load();
  }, [current?.offering.offeringId, current?.stage]);

  if (!current) {
    return (
      <Empty title="No marks to enter">You have no course teacher or SEE examiner duty.</Empty>
    );
  }

  const head = loaded?.head;
  const canEdit = !!loaded && (!head || !head.submittedAt || head.review?.verdict === 'returned');
  const canSubmit = !!head && !head.submittedAt && !dirty;
  const invalid =
    !!loaded &&
    loaded.roster.some((student) =>
      loaded.form.components.some(
        (component, i) =>
          !valid(
            values[student.enrolmentId]?.[i] ?? '',
            component.maximum,
            loaded.form.absenceAllowed,
          ),
      ),
    );

  function edit(enrolmentId: string, index: number, value: string) {
    setValues((all) => {
      const row = [...(all[enrolmentId] ?? [])];
      row[index] = value;
      return { ...all, [enrolmentId]: row };
    });
    setDirty(true);
    setNotice('');
    key.current = null;
  }

  async function save() {
    if (!loaded) return;
    const rows = loaded.roster
      .map((student) => ({
        enrolmentId: student.enrolmentId,
        values: (values[student.enrolmentId] ?? []).map((v) =>
          v.trim().toUpperCase() === 'AB' ? 'AB' : v.trim(),
        ),
      }))
      // SEE revisions may cover only the students eligible for SEE.
      .filter((row) => current!.stage === 'cie' || row.values.some((v) => v !== ''));
    key.current ??= newKey();
    setBusy(true);
    setError('');
    try {
      const created = await api<PilotBatchCreated>(
        `/pilot/offerings/${current!.offering.offeringId}/batches`,
        {
          stage: current!.stage,
          expectedRevision: head?.revisionNo ?? 0,
          components: loaded.form.components.map((c) => c.code),
          rows,
        },
        key.current,
      );
      await refreshHead();
      setNotice(`Saved revision ${created.revisionNo}. Submit it when the marks are final.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!head) return;
    setBusy(true);
    setError('');
    try {
      await api(`/pilot/batches/${head.batchId}/submit`, {});
      await refreshHead();
      setNotice(
        current!.stage === 'cie'
          ? 'Submitted for department review.'
          : 'Submitted to the exam section for publication.',
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={`${stageName(current.stage)} marks`}
      subtitle="Each save creates an immutable revision; only the latest revision can be submitted."
    >
      <div className="pilot-toolbar">
        <div className="field pilot-picker">
          <label htmlFor="pilot-entry">Offering and stage</label>
          <select
            id="pilot-entry"
            value={choice}
            onChange={(e) => setChoice(Number(e.target.value))}
          >
            {choices.map((c, i) => (
              <option key={`${c.offering.offeringId}:${c.stage}`} value={i}>
                {offeringLabel(c.offering)} — {stageName(c.stage)}
              </option>
            ))}
          </select>
        </div>
        <div className="status-row" aria-live="polite">
          <BatchState batch={head} />
          {head?.validation && (
            <span className="pilot-audit">
              Validated by {head.validation.validatorSubject}: {head.validation.missingRows} missing
              rows
            </span>
          )}
        </div>
      </div>
      {head?.review?.verdict === 'returned' && (
        <Alert>
          Returned by {head.review.reviewerSubject}: {head.review.reason}. Correct the marks and
          save a new revision.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {!loaded && !error && <p role="status">Loading the roster and latest revision…</p>}
      {loaded && (
        <>
          <div
            className="table-scroll pilot-grid"
            role="region"
            aria-label="Marks entry grid"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  {loaded.form.components.map((c) => (
                    <th key={c.code}>
                      {c.code}
                      <small>
                        / {Number(c.maximum)} · {c.kind}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loaded.roster.map((student) => (
                  <tr key={student.enrolmentId}>
                    <td>{student.studentCode}</td>
                    {loaded.form.components.map((c, i) => {
                      const value = values[student.enrolmentId]?.[i] ?? '';
                      return (
                        <td key={c.code}>
                          <input
                            aria-label={`${student.studentCode} ${c.code}`}
                            value={value}
                            disabled={!canEdit || busy}
                            inputMode="decimal"
                            aria-invalid={
                              !valid(value, c.maximum, loaded.form.absenceAllowed) || undefined
                            }
                            onChange={(e) => edit(student.enrolmentId, i, e.target.value)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pilot-actions">
            <button
              className="primary"
              disabled={!canEdit || !dirty || invalid || busy}
              onClick={() => void save()}
            >
              Save revision
            </button>
            <button
              className="secondary"
              disabled={!canSubmit || busy}
              onClick={() => void submit()}
            >
              Submit revision {head?.revisionNo ?? ''}
            </button>
            {loaded.form.absenceAllowed && <small>Enter AB for an absent student.</small>}
            {!canEdit && head?.submittedAt && !head.review && (
              <small>Submitted revisions are locked while they await the next step.</small>
            )}
            {head?.review?.verdict === 'approved' && (
              <small>The approved revision is locked for publication.</small>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
