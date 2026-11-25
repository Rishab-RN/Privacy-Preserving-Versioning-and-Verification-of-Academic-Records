import { useState } from 'react';
import type { ChangeRequestStatus } from '@scholarproof/contracts';
import type { Api } from '../types.js';
import { message } from '../api.js';
import { date, idPattern } from '../format.js';
import { Panel, Field, Alert, Badge, Empty } from '../ui.js';
export function Review({
  api,
  registrar,
  actor,
  recent,
  activeRequest,
  remember,
  openProvenance,
}: {
  api: Api;
  registrar: boolean;
  actor: string;
  recent: string[];
  activeRequest: string;
  remember: (id: string) => void;
  openProvenance: (recordId: string, version: number) => void;
}) {
  const [id, setId] = useState(activeRequest),
    [result, setResult] = useState<ChangeRequestStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState(''),
    [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  async function load(value: string) {
    setBusy(true);
    setError('');
    setResult(null);
    setConfirm(null);
    try {
      const status = await api<ChangeRequestStatus>(`/change-requests/${value}`);
      setResult(status);
      remember(value);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function decide() {
    if (!confirm || !result) return;
    setBusy(true);
    setError('');
    try {
      setResult(
        await api<ChangeRequestStatus>(`/change-requests/${result.requestId}/${confirm}`, {
          reason: reason.trim(),
        }),
      );
      setConfirm(null);
    } catch (e) {
      setError(message(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Panel
        title="Find a correction request"
        subtitle="Enter a request ID shared by a registrar. Access is checked for each request."
      >
        <form
          className="request-search"
          onSubmit={(e) => {
            e.preventDefault();
            void load(id);
          }}
        >
          <Field label="Request ID">
            <input
              value={id}
              required
              pattern={idPattern}
              onChange={(e) => {
                setId(e.target.value);
                setResult(null);
                setConfirm(null);
              }}
              placeholder="Enter correction request UUID"
            />
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? 'Loading…' : 'Find request'}
          </button>
        </form>
        {recent.length > 0 && (
          <div className="recent">
            <span>THIS SESSION</span>
            {recent.map((value) => (
              <button
                key={value}
                onClick={() => {
                  setId(value);
                  void load(value);
                }}
              >
                {value.slice(0, 8)}…
              </button>
            ))}
          </div>
        )}
      </Panel>
      {error && <Alert>{error}</Alert>}
      {result ? (
        <div className="two-col">
          <Panel title="Proposed correction" subtitle={`Record ${result.recordId}`}>
            <div className="status-row">
              <Badge
                tone={
                  result.decision?.code === 'approved'
                    ? 'green'
                    : result.decision?.code === 'rejected'
                      ? 'red'
                      : 'amber'
                }
              >
                {result.decision?.code ?? 'Awaiting decision'}
              </Badge>
              {result.stale && !result.decision && (
                <Badge tone="amber">Record has a newer version</Badge>
              )}
            </div>
            <dl className="facts">
              <div>
                <dt>Proposed grade</dt>
                <dd>
                  {result.gradePoints ?? '—'} · {result.outcome}
                </dd>
              </div>
              <div>
                <dt>Expected / current version</dt>
                <dd>
                  {result.expectedVersion} / {result.currentVersion}
                </dd>
              </div>
              <div>
                <dt>Effective interval</dt>
                <dd>
                  {date(result.validFrom)} →{' '}
                  {result.validUntil ? date(result.validUntil) : 'No end date'}
                </dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{date(result.submittedAt)}</dd>
              </div>
              <div>
                <dt>Evidence ID</dt>
                <dd>
                  <code>{result.evidenceId}</code>
                </dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{result.reason}</dd>
              </div>
            </dl>
            {result.decision && (
              <div className="decision-note">
                <h3>Recorded decision</h3>
                <p>{result.decision.reason}</p>
                <small>
                  {date(result.decision.decidedAt)}
                  {result.decision.versionNo !== null
                    ? ` · Applied version ${result.decision.versionNo}`
                    : ''}
                </small>
              </div>
            )}
            {registrar &&
              !result.decision &&
              (result.submittedBy === actor ? (
                <p className="scope-note">A different registrar must review your proposal.</p>
              ) : (
                <>
                  <Field label="Decision reason">
                    <textarea
                      value={reason}
                      maxLength={500}
                      rows={3}
                      onChange={(e) => setReason(e.target.value)}
                      required
                    />
                  </Field>
                  {confirm ? (
                    <div className="confirm-box">
                      <strong>Confirm {confirm === 'approve' ? 'approval' : 'rejection'}?</strong>
                      <p>
                        {confirm === 'approve'
                          ? 'This commits a new immutable academic revision.'
                          : 'This records an immutable rejection.'}
                      </p>
                      <button
                        className="primary"
                        disabled={busy || !reason.trim()}
                        onClick={() => void decide()}
                      >
                        Confirm {confirm === 'approve' ? 'approval' : 'rejection'}
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setConfirm(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="button-row">
                      <button
                        className="primary"
                        disabled={busy || !reason.trim() || result.stale}
                        onClick={() => setConfirm('approve')}
                      >
                        Approve correction
                      </button>
                      <button
                        className="danger"
                        disabled={busy || !reason.trim()}
                        onClick={() => setConfirm('reject')}
                      >
                        Reject request
                      </button>
                    </div>
                  )}
                </>
              ))}
          </Panel>
          <Panel
            title="Delivery & history"
            subtitle="Academic acceptance and document delivery are separate stages."
          >
            {result.decision?.versionNo && (
              <button
                className="secondary"
                onClick={() => openProvenance(result.recordId, result.decision!.versionNo!)}
              >
                View version provenance
              </button>
            )}
            <ol className="delivery-list">
              {result.deliveries.map((d) => (
                <li key={d.eventId}>
                  <span className={`delivery-dot ${d.state}`} />
                  <div>
                    <strong>
                      {d.kind === 'grade.accepted'
                        ? 'Academic revision accepted'
                        : d.kind === 'request.rejected'
                          ? 'Request rejected'
                          : 'Proposal recorded'}
                    </strong>
                    <p>
                      <Badge
                        tone={
                          d.state === 'delivered'
                            ? 'green'
                            : d.state === 'quarantined'
                              ? 'red'
                              : 'amber'
                        }
                      >
                        {d.state}
                      </Badge>{' '}
                      · {d.attempts} delivery attempts
                    </p>
                    {d.lastErrorCode && <small>{d.lastErrorCode}</small>}
                  </div>
                </li>
              ))}
            </ol>
            <p className="muted inset">
              A pending delivery does not undo an accepted record revision. It also does not confirm
              that a signed credential has been published.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void load(result.requestId)}
            >
              Refresh status
            </button>
          </Panel>
        </div>
      ) : (
        !busy && (
          <Empty title="A clear trail for every decision">
            Find a request to inspect its proposal, decision and delivery state.
          </Empty>
        )
      )}
    </>
  );
}
