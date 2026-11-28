import { useEffect, useState } from 'react';
import type { PilotStudentResult } from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message } from '../../api.js';
import { date, human } from '../../format.js';
import { Alert, Badge, Empty, Panel } from '../../ui.js';
import { Score } from './shared.js';

/** A student's own published results, with the CIE and SEE breakdown. */
export function MyResults({ api }: { api: Api }) {
  const [results, setResults] = useState<PilotStudentResult[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ results: PilotStudentResult[] }>('/pilot/my-results').then(
      (value) => setResults(value.results),
      (e) => setError(message(e)),
    );
  }, []);
  return (
    <Panel
      title="My course results"
      subtitle="Results appear here once the exam section publishes them."
    >
      {error && <Alert>{error}</Alert>}
      {results === null && !error && <p role="status">Loading your results…</p>}
      {results?.length === 0 && (
        <Empty title="No published results yet">
          Your marks become visible after provisional publication.
        </Empty>
      )}
      {!!results?.length && (
        <div className="pilot-cards">
          {results.map((r) => (
            <article className="pilot-card" key={r.offeringId}>
              <header>
                <div>
                  <h3>{r.courseCode}</h3>
                  <small>
                    Section {r.section} · {r.term} · published {date(r.publishedAt)}
                  </small>
                </div>
                <div className="status-row">
                  <Badge tone="amber">{r.label}</Badge>
                  {r.revisedAfterPvp && <Badge tone="green">Revised after paper viewing</Badge>}
                </div>
              </header>
              <div className="pilot-letter" aria-label={`Grade ${r.letter ?? r.status}`}>
                {r.letter ?? '—'}
              </div>
              <p className="pilot-audit">
                {r.gradePoints === null
                  ? `No grade points: ${human(r.status)}`
                  : `${r.gradePoints.toFixed(2)} grade points · ${r.outcome}`}{' '}
                · version {r.versionNo}
              </p>
              {r.reasons.length > 0 && (
                <p className="pilot-audit">{r.reasons.map(human).join(', ').toLowerCase()}</p>
              )}
              <div className="pilot-scores">
                <Score label="CIE theory" score={r.cie.theory} />
                <Score label="CIE lab" score={r.cie.lab} />
                <Score label="SEE theory" score={r.see?.theory} />
                <Score label="SEE lab" score={r.see?.lab} />
                <Score label="Total" score={r.total} />
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
