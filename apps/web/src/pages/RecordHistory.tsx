import { useEffect, useRef, useState } from 'react';
import type { RecordHistoryResponse } from '@scholarproof/contracts';
import type { Api } from '../types.js';
import { message } from '../api.js';
import { date, human } from '../format.js';
import { Alert, Panel } from '../ui.js';
import { VersionInspector } from './VersionInspector.js';

export function RecordHistory({
  api,
  recordId,
  course,
}: {
  api: Api;
  recordId: string;
  course: string;
}) {
  const [page, setPage] = useState<RecordHistoryResponse['revisions']>([]);
  const [next, setNext] = useState<number | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    const path = '/records/' + recordId + '/history' + (before ? '?before=' + before : '');
    void api<RecordHistoryResponse>(path)
      .then((data) => {
        if (active) {
          setPage((previous) => (before ? [...previous, ...data.revisions] : data.revisions));
          setNext(data.nextBefore);
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(message(failure));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [recordId, before, attempt]);
  return (
    <div ref={panel} tabIndex={-1} aria-label={`${course} recorded history`}>
      <Panel
        title={`${course} recorded history`}
        subtitle="Revisions by recording order. Effective dates are shown for each version."
      >
        {error && <Alert>{error}</Alert>}
        {!!page.length && <VersionInspector revisions={page} />}
        {!!page.length && (
          <div className="table-scroll" role="region" aria-label="Recorded revisions" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Grade points</th>
                  <th>Outcome</th>
                  <th>Recorded at</th>
                  <th>Effective interval</th>
                </tr>
              </thead>
              <tbody>
                {page.map((revision) => (
                  <tr key={revision.version_no}>
                    <td>v{revision.version_no}</td>
                    <td>{revision.grade_points ?? '—'}</td>
                    <td>{human(revision.outcome)}</td>
                    <td>{date(revision.recorded_at)}</td>
                    <td>{revision.valid_during}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {busy && <p role="status">Loading revisions…</p>}
        {!busy && !error && !page.length && <p>No recorded revisions.</p>}
        {error ? (
          <button
            className="secondary"
            onClick={() => {
              setError('');
              setBusy(true);
              retry(attempt + 1);
            }}
          >
            Retry history
          </button>
        ) : (
          next !== null && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setBefore(next);
              }}
            >
              Load older revisions
            </button>
          )
        )}
      </Panel>
    </div>
  );
}
