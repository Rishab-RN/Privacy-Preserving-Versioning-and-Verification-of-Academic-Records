import type { PilotPublication, PilotPublishedResult } from '@scholarproof/contracts';
import { date } from '../../format.js';
import { Badge } from '../../ui.js';

/** A publication's results with the recomputation audit, optionally selectable per row. */
export function ResultsTable({
  publication,
  action,
}: {
  publication: PilotPublication;
  action?: { label: string; onSelect: (row: PilotPublishedResult) => void };
}) {
  const { audit } = publication;
  return (
    <>
      <p className="pilot-audit">
        {publication.kind === 'final' ? 'Final' : 'Provisional'} results published{' '}
        {date(publication.publishedAt)} by {publication.publisherSubject} under{' '}
        {publication.policy.id} v{publication.policy.version}.{' '}
        {audit.mismatches.length === 0 ? (
          <Badge tone="green">Audit: all {audit.records} grades recompute</Badge>
        ) : (
          <Badge tone="red">Audit: {audit.mismatches.join(', ')} do not recompute</Badge>
        )}
      </p>
      <div className="table-scroll" role="region" aria-label="Published results" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Grade</th>
              <th>Grade points</th>
              <th>Outcome</th>
              <th>Total</th>
              <th>Version</th>
              <th>Audit</th>
              {action && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {publication.results.map((row) => (
              <tr key={row.enrolmentId}>
                <td>{row.studentCode}</td>
                <td>{row.letter ?? '—'}</td>
                <td>{row.gradePoints?.toFixed(2) ?? '—'}</td>
                <td>
                  {row.outcome}
                  {row.status !== 'graded' && <small> ({row.status})</small>}
                </td>
                <td>{row.total ? `${row.total.percent}%` : '—'}</td>
                <td>
                  v{row.versionNo}
                  {row.revisedAfterPvp && (
                    <>
                      {' '}
                      <Badge tone="amber">revised after paper viewing</Badge>
                    </>
                  )}
                </td>
                <td>{row.matches ? '✓' : <Badge tone="red">mismatch</Badge>}</td>
                {action && (
                  <td>
                    <button className="text-button" onClick={() => action.onSelect(row)}>
                      {action.label} {row.studentCode}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
