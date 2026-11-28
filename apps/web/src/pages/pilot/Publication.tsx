import { useEffect, useState } from 'react';
import type {
  PilotAttendance,
  PilotBatchSummary,
  PilotDeskOffering,
  PilotFinalizeResult,
  PilotPublication,
  PilotPublishResult,
  PilotRoster,
} from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message, RequestFailure } from '../../api.js';
import { Alert, Badge, Empty, Field, Panel } from '../../ui.js';
import { ResultsTable } from './ResultsTable.js';
import { fullRoster, OfferingPicker } from './shared.js';

/** Loads an offering's publication, or null when it has not been published yet. */
export async function loadPublication(api: Api, offeringId: string) {
  try {
    return await api<PilotPublication>(`/pilot/offerings/${offeringId}/publication`);
  } catch (e) {
    if (e instanceof RequestFailure && e.code === 'NOT_PUBLISHED') return null;
    throw e;
  }
}

type Row = { eligible: boolean; percent: string };

/** Exam approvers publish provisional results with imported attendance. */
export function Publication({
  api,
  offerings,
  changed,
}: {
  api: Api;
  offerings: PilotDeskOffering[];
  changed: () => void;
}) {
  const [offeringId, setOfferingId] = useState(offerings[0]?.offeringId ?? '');
  const [state, setState] = useState<{
    publication: PilotPublication | null;
    cie: PilotBatchSummary | undefined;
    see: PilotBatchSummary | undefined;
    roster: PilotRoster['students'];
  } | null>(null);
  const [attendance, setAttendance] = useState<Record<string, Row>>({});
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    if (!offeringId) return;
    setError('');
    setState(null);
    try {
      const publication = await loadPublication(api, offeringId);
      // Readiness and attendance matter only until the offering is published.
      const [list, roster] = publication
        ? [{ batches: [] as PilotBatchSummary[] }, []]
        : await Promise.all([
            api<{ batches: PilotBatchSummary[] }>(`/pilot/offerings/${offeringId}/batches`),
            fullRoster(api, offeringId),
          ]);
      setState({
        publication,
        cie: list.batches.filter((b) => b.stage === 'cie').at(-1),
        see: list.batches.filter((b) => b.stage === 'see').at(-1),
        roster,
      });
      setAttendance(
        Object.fromEntries(roster.map((s) => [s.enrolmentId, { eligible: true, percent: '' }])),
      );
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    setNotice('');
    void load();
  }, [offeringId]);

  if (!offerings.length) {
    return <Empty title="Nothing to publish">You hold no publishing duty here.</Empty>;
  }

  const cieReady = state?.cie?.review?.verdict === 'approved';
  const seeReady = !!state?.see?.submittedAt;

  /** Applies pasted lines of `USN, percent, eligible` to the attendance table. */
  function applyCsv() {
    if (!state) return;
    const byCode = new Map(state.roster.map((s) => [s.studentCode.toUpperCase(), s.enrolmentId]));
    const next = { ...attendance };
    const unknown: string[] = [];
    for (const line of csv.split(/\r?\n/)) {
      const [code = '', percent = '', eligible = ''] = line.split(',').map((part) => part.trim());
      if (!code) continue;
      const id = byCode.get(code.toUpperCase());
      if (!id) {
        unknown.push(code);
        continue;
      }
      next[id] = { percent, eligible: !/^(no|n|false|0)$/i.test(eligible) };
    }
    setAttendance(next);
    setError(unknown.length ? `Not in this roster: ${unknown.join(', ')}` : '');
  }

  async function publish() {
    if (!state) return;
    setBusy(true);
    setError('');
    try {
      const rows: PilotAttendance[] = state.roster.map((s) => {
        const row = attendance[s.enrolmentId] ?? { eligible: true, percent: '' };
        return {
          enrolmentId: s.enrolmentId,
          eligible: row.eligible,
          ...(row.percent.trim() ? { percent: row.percent.trim() } : {}),
        };
      });
      const result = await api<PilotPublishResult>(`/pilot/offerings/${offeringId}/publish`, {
        attendance: rows,
      });
      setNotice(`Published ${result.records} provisional results.`);
      changed();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    setBusy(true);
    setError('');
    try {
      const result = await api<PilotFinalizeResult>(`/pilot/offerings/${offeringId}/finalize`, {});
      setNotice(
        `Declared ${result.records} results final; ${result.revised} changed after paper viewing.`,
      );
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const pending = state?.publication?.pendingCorrections ?? 0;
  return (
    <Panel
      title="Publish results"
      subtitle="Provisional publication needs the approved CIE revision and the submitted SEE revision; final publication closes paper viewing. You cannot publish an offering whose marks you entered, validated or reviewed."
    >
      <div className="pilot-toolbar">
        <OfferingPicker offerings={offerings} value={offeringId} onChange={setOfferingId} />
        {state && !state.publication && (
          <div className="status-row">
            <Badge tone={cieReady ? 'green' : 'amber'}>
              CIE {cieReady ? 'approved' : 'not approved'}
            </Badge>
            <Badge tone={seeReady ? 'green' : 'amber'}>
              SEE {seeReady ? 'submitted' : 'not submitted'}
            </Badge>
          </div>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {!state && !error && <p role="status">Loading the offering…</p>}
      {state?.publication && (
        <>
          <ResultsTable publication={state.publication} />
          {!state.publication.final && (
            <div className="pilot-actions">
              <button
                className="primary"
                disabled={busy || pending > 0}
                onClick={() => void finalize()}
              >
                Publish final results
              </button>
              <small>
                {pending > 0
                  ? `${pending} correction request${pending === 1 ? '' : 's'} must be decided first.`
                  : 'Publish once the paper-viewing window has closed. Final grades cannot be corrected.'}
              </small>
            </div>
          )}
        </>
      )}
      {state && !state.publication && (
        <>
          <Field
            label="Paste attendance"
            hint="One student per line: USN, percentage, eligible (yes or no). Students not listed stay eligible."
          >
            <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} />
          </Field>
          <div className="pilot-actions">
            <button className="secondary" disabled={!csv.trim()} onClick={applyCsv}>
              Apply pasted attendance
            </button>
          </div>
          <div className="table-scroll" role="region" aria-label="Attendance" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Eligible after condonation</th>
                  <th>Attendance %</th>
                </tr>
              </thead>
              <tbody>
                {state.roster.map((s) => {
                  const row = attendance[s.enrolmentId] ?? { eligible: true, percent: '' };
                  return (
                    <tr key={s.enrolmentId}>
                      <td>{s.studentCode}</td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${s.studentCode} eligible`}
                          checked={row.eligible}
                          onChange={(e) =>
                            setAttendance((all) => ({
                              ...all,
                              [s.enrolmentId]: { ...row, eligible: e.target.checked },
                            }))
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`${s.studentCode} attendance percent`}
                          inputMode="decimal"
                          value={row.percent}
                          onChange={(e) =>
                            setAttendance((all) => ({
                              ...all,
                              [s.enrolmentId]: { ...row, percent: e.target.value },
                            }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pilot-actions">
            <button
              className="primary"
              disabled={busy || !cieReady || !seeReady}
              onClick={() => void publish()}
            >
              Publish provisional results
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Course teachers, HoDs, exam approvers, registrars and auditors read published results. */
export function Results({ api, offerings }: { api: Api; offerings: PilotDeskOffering[] }) {
  const [offeringId, setOfferingId] = useState(offerings[0]?.offeringId ?? '');
  const [publication, setPublication] = useState<PilotPublication | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!offeringId) return;
    setPublication(undefined);
    setError('');
    loadPublication(api, offeringId).then(setPublication, (e) => setError(message(e)));
  }, [offeringId]);
  if (!offerings.length) {
    return <Empty title="No results in scope">You hold no results duty here.</Empty>;
  }
  return (
    <Panel
      title="Published results"
      subtitle="Every grade is recomputed from the stored marks, attendance and policy each time it is shown."
    >
      <div className="pilot-toolbar">
        <OfferingPicker offerings={offerings} value={offeringId} onChange={setOfferingId} />
      </div>
      {error && <Alert>{error}</Alert>}
      {publication === undefined && !error && <p role="status">Loading results…</p>}
      {publication === null && (
        <Empty title="Not published yet">This offering has no provisional results yet.</Empty>
      )}
      {publication && <ResultsTable publication={publication} />}
    </Panel>
  );
}
