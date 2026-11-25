import { useState } from 'react';
import type { RecordHistoryResponse } from '@scholarproof/contracts';
import { date, human } from '../format.js';

export function VersionInspector({ revisions }: { revisions: RecordHistoryResponse['revisions'] }) {
  const [version, setVersion] = useState(revisions[0]!.version_no);
  const selected = revisions.find((item) => item.version_no === version) ?? revisions[0]!;
  const previous = revisions.find((item) => item.version_no === selected.version_no - 1);
  const delta =
    selected.grade_points !== null && previous?.grade_points != null
      ? Number(selected.grade_points) - Number(previous.grade_points)
      : null;
  return (
    <div className="version-inspector">
      <div className="version-rail" role="group" aria-label="Select recorded version">
        {revisions.map((item) => (
          <button
            type="button"
            key={item.version_no}
            aria-pressed={item.version_no === selected.version_no}
            onClick={() => setVersion(item.version_no)}
          >
            <span>v{item.version_no}</span>
            <small>{item.grade_points ?? 'No grade'}</small>
          </button>
        ))}
      </div>
      <div className="version-detail" aria-live="polite">
        <div>
          <span className="workspace-label">Selected revision</span>
          <strong className="revision-grade">{selected.grade_points ?? '—'}</strong>
          <div className="revision-meta">
            Version {selected.version_no} · {human(selected.outcome)}
          </div>
        </div>
        <dl>
          <div>
            <dt>Recorded</dt>
            <dd>{date(selected.recorded_at)}</dd>
          </div>
          <div>
            <dt>Effective interval</dt>
            <dd>
              <code>{selected.valid_during}</code>
            </dd>
          </div>
          {delta !== null && (
            <div>
              <dt>Change from v{previous!.version_no}</dt>
              <dd>
                {delta > 0 ? '+' : ''}
                {delta.toFixed(2)} grade points
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
