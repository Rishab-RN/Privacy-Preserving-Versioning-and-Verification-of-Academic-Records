import { useState } from 'react';
import type { TranscriptResponse } from '@scholarproof/contracts';
import { Empty, Badge, Icon } from '../ui.js';
import { human, date } from '../format.js';
export function RecordsTable({
  records,
  loading,
  detailed = false,
  onHistory,
}: {
  records: TranscriptResponse['records'];
  loading: boolean;
  detailed?: boolean;
  onHistory?: (record: TranscriptResponse['records'][number]) => void;
}) {
  const [search, setSearch] = useState('');
  const visible = records.filter((r) => r.course_code.toLowerCase().includes(search.toLowerCase()));
  if (loading)
    return (
      <div role="status" className="empty">
        Loading authorised records…
      </div>
    );
  if (!records.length)
    return (
      <Empty title="No results in this view">
        No academic results match this student and the selected query time.
      </Empty>
    );
  return (
    <>
      <div className="table-tools">
        <input
          aria-label="Search course code"
          type="search"
          placeholder="Search course code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span>{visible.length} results</span>
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Course results table; scroll horizontally for more columns"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Course</th>
              <th>Credits</th>
              <th>Grade points</th>
              <th>Outcome</th>
              <th>Version</th>
              {detailed && <th>Recorded at</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.record_id}>
                <td>
                  {onHistory ? (
                    <button
                      type="button"
                      className="course-history"
                      aria-label={`View ${r.course_code} history`}
                      onClick={() => onHistory(r)}
                    >
                      {r.course_code} <Icon name="arrow" />
                    </button>
                  ) : (
                    <strong>{r.course_code}</strong>
                  )}
                  {detailed && <code className="record-id">{r.record_id}</code>}
                </td>
                <td>{r.credits}</td>
                <td className="grade">{r.grade_points ?? '—'}</td>
                <td>
                  <Badge
                    tone={
                      r.outcome === 'passed' ? 'green' : r.outcome === 'failed' ? 'red' : 'neutral'
                    }
                  >
                    {human(r.outcome)}
                  </Badge>
                </td>
                <td>
                  <span className="version">v{r.version_no}</span>
                </td>
                {detailed && (
                  <td>
                    {date(r.recorded_at)}
                    <small className="range">Valid interval: {r.valid_during}</small>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <p className="table-empty">No course codes match your search.</p>}
      </div>
    </>
  );
}
