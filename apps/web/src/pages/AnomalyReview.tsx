import { useState } from 'react';
import type {
  AnomalyFeature,
  AnomalyRank,
  AnomalyReview as ReviewData,
} from '@scholarproof/contracts';
import { date } from '../format.js';
import { Badge, Panel } from '../ui.js';

const labels: Record<AnomalyFeature, string> = {
  delta: 'Grade change',
  missingDelta: 'Numeric grade change unavailable',
  record30d: 'Prior corrections to this record',
  course30d: 'Prior corrections in this course',
  proposer30d: 'Prior corrections from this proposer',
  pair30d: 'Prior approvals with this actor pair',
  evidence30d: 'Prior approvals using this evidence digest',
};
const unavailable = {
  'missing-snapshot': 'No scoring snapshot has been published for this institution.',
  'invalid-snapshot': 'The scoring snapshot could not be read.',
  'graph-unavailable': 'Neo4j is unavailable. Score freshness could not be checked.',
};
function displayValue(feature: AnomalyFeature, value: number) {
  if (feature === 'delta') return `${value > 0 ? '+' : ''}${(value / 100).toFixed(2)} points`;
  if (feature === 'missingDelta') return value ? 'Yes' : 'No';
  return `${value} in prior 30 days`;
}

export function AnomalyReview({
  result,
  openRequest,
  targeted,
}: {
  result: ReviewData;
  openRequest: (requestId: string) => void;
  targeted: boolean;
}) {
  const [request, setRequest] = useState<AnomalyRank | null>(
    result.status === 'current' ? result.selected : null,
  );
  const selected = request ?? (result.status === 'current' ? result.queue[0] : null);
  return (
    <Panel
      title="Anomaly review"
      subtitle="Advisory scores from a model trained on synthetic corrections."
    >
      {result.status === 'unavailable' ? (
        <p role="status">
          <Badge tone="amber">Scores unavailable</Badge> {unavailable[result.reason]}
        </p>
      ) : (
        <>
          <p role="status">
            <Badge tone={result.status === 'current' ? 'green' : 'amber'}>
              {result.status === 'current' ? 'Current snapshot' : 'Stale snapshot'}
            </Badge>{' '}
            Scored through {result.through} of {result.committed} committed log positions.
          </p>
          <p className="muted">
            Generated {date(result.generatedAt)} · <code>{result.modelVersion}</code>
          </p>
          {result.status === 'stale' ? (
            <p>Sync Neo4j and publish a fresh scoring snapshot to continue.</p>
          ) : !selected ? (
            <p>No approved corrections are available to rank.</p>
          ) : (
            <>
              {targeted && !result.selected && <p>No score for the requested version.</p>}
              <div className="risk-grid">
                <div>
                  <h3>Highest-ranked corrections</h3>
                  <div className="risk-queue" role="group" aria-label="Choose a ranked correction">
                    {result.queue.map((item) => (
                      <button
                        type="button"
                        key={item.requestId}
                        aria-pressed={item.requestId === selected.requestId}
                        onClick={() => setRequest(item)}
                      >
                        <span>
                          #{item.rank} · Version {item.version}
                        </span>
                        <span>{item.score.toFixed(3)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="risk-detail" aria-live="polite">
                  <div className="status-row">
                    <h3>
                      Rank {selected.rank} of {result.total}
                    </h3>
                    <Badge tone={selected.flagged ? 'amber' : 'neutral'}>
                      {selected.flagged ? 'Above review cutoff' : 'Below review cutoff'}
                    </Badge>
                  </div>
                  <p>
                    Score {selected.score.toFixed(3)} · Validation cutoff{' '}
                    {result.threshold.toFixed(3)}
                  </p>
                  <p>
                    Version {selected.version} · {date(selected.occurredAt)}
                  </p>
                  <h3>Features that increased this score</h3>
                  {selected.signals.length ? (
                    <dl className="facts">
                      {selected.signals.map((signal) => (
                        <div key={signal.feature}>
                          <dt>{labels[signal.feature]}</dt>
                          <dd>{displayValue(signal.feature, signal.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p>
                      No single reported feature increased the score compared with its training
                      median.
                    </p>
                  )}
                  {!!selected.rules.length && (
                    <p>
                      Rule signals · {selected.rules.map((feature) => labels[feature]).join(', ')}
                    </p>
                  )}
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => openRequest(selected.requestId)}
                  >
                    Review this correction
                  </button>
                </div>
              </div>
              <p className="muted">
                Review scores are separate from cryptographic integrity and academic decisions.
              </p>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
