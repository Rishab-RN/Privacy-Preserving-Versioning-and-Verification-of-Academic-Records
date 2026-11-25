import { useState } from 'react';
import type { FormEvent } from 'react';
import type {
  EvidenceReceipt,
  TranscriptResponse,
  ChangeRequestStatus,
  ChangeProposalInput,
  GradeOutcome,
} from '@scholarproof/contracts';
import type { Api } from '../types.js';
import { message } from '../api.js';
import { idPattern } from '../format.js';
import { Panel, Field, Alert, Icon, Badge, Empty } from '../ui.js';
export function Evidence({
  api,
  records,
  receipt,
  onReceipt,
  registrar,
  remember,
}: {
  api: Api;
  records: TranscriptResponse['records'];
  receipt: EvidenceReceipt | null;
  onReceipt: (r: EvidenceReceipt) => void;
  registrar: boolean;
  remember: (id: string) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [record, setRecord] = useState(records[0]?.record_id ?? ''),
    [lookup, setLookup] = useState(''),
    [document, setDocument] = useState<{
      evidenceId: string;
      recordId: string;
      digestSha256: string;
      content: unknown;
    } | null>(null);
  const [retry, setRetry] = useState<{ payload: string; key: string } | null>(null);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const input = {
      schemaVersion: 1,
      category: data.get('category'),
      data: { note: String(data.get('note')).trim() },
    };
    const payload = JSON.stringify({ record, input });
    const key = retry?.payload === payload ? retry.key : crypto.randomUUID();
    setRetry({ payload, key });
    try {
      const value = await api<EvidenceReceipt>(`/records/${record}/evidence`, input, key);
      onReceipt(value);
      setLookup(value.evidenceId);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function retrieve(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    setDocument(null);
    try {
      setDocument(await api(`/evidence/${lookup}`));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <div className="two-col">
        <Panel
          title="Add supporting information"
          subtitle="A structured note is stored with an immutable integrity reference."
        >
          <form onSubmit={(e) => void upload(e)}>
            <Field label="Record ID">
              <input
                list="record-options"
                required
                pattern={idPattern}
                value={record}
                onChange={(e) => setRecord(e.target.value)}
                placeholder="Choose a record or enter its UUID"
              />
              <datalist id="record-options">
                {records.map((r) => (
                  <option key={r.record_id} value={r.record_id}>
                    {r.course_code}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Evidence category">
              <select name="category">
                <option value="supporting_note">Supporting note</option>
                <option value="revaluation_request">Revaluation request</option>
              </select>
            </Field>
            <Field
              label="Supporting note"
              hint="Use relevant information only. Maximum 4,000 characters."
            >
              <textarea
                name="note"
                required
                maxLength={4000}
                rows={5}
                placeholder="Explain the supporting information…"
              />
            </Field>
            <button className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save evidence'}
              <Icon name="arrow" />
            </button>
          </form>
        </Panel>
        <Panel
          title="Evidence reference"
          subtitle="Keep this reference when submitting a correction."
        >
          {receipt ? (
            <div className="receipt" role="status">
              <Badge tone="green">
                <Icon name="check" /> Available
              </Badge>
              <Field label="Evidence ID">
                <input value={receipt.evidenceId} readOnly />
              </Field>
              <span className="mini-label">SHA-256 DIGEST</span>
              <code className="digest">{receipt.digestSha256}</code>
              <p>{receipt.sizeBytes} bytes · Content confirmed before availability.</p>
            </div>
          ) : (
            <Empty title="No evidence saved in this session">
              Save a supporting note to receive its evidence ID and integrity digest.
            </Empty>
          )}
          <form className="lookup" onSubmit={(e) => void retrieve(e)}>
            <Field label="Retrieve evidence by ID">
              <input
                required
                pattern={idPattern}
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                placeholder="Evidence UUID"
              />
            </Field>
            <button className="secondary" disabled={busy}>
              Retrieve evidence
            </button>
          </form>
          {document && (
            <div className="document-result">
              <h3>Verified evidence content</h3>
              <code className="digest">{document.recordId}</code>
              <pre>{JSON.stringify(document.content, null, 2)}</pre>
            </div>
          )}
        </Panel>
      </div>
      {registrar && (
        <Proposal
          api={api}
          record={record}
          evidence={receipt?.evidenceId ?? ''}
          remember={remember}
        />
      )}
    </>
  );
}
function Proposal({
  api,
  record,
  evidence,
  remember,
}: {
  api: Api;
  record: string;
  evidence: string;
  remember: (id: string) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<GradeOutcome>('passed'),
    [result, setResult] = useState<ChangeRequestStatus | null>(null),
    [retry, setRetry] = useState<{
      payload: string;
      key: string;
      input: ChangeProposalInput;
    } | null>(null);
  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    const form = new FormData(event.currentTarget);
    try {
      const fields = {
        gradePoints: ['withdrawn', 'incomplete'].includes(outcome)
          ? null
          : String(form.get('points')),
        outcome,
        validFrom: new Date(String(form.get('from'))).toISOString(),
        validUntil: form.get('until') ? new Date(String(form.get('until'))).toISOString() : null,
        evidenceId: String(form.get('evidence')),
        reason: String(form.get('reason')).trim(),
      };
      const payload = JSON.stringify({ record, fields });
      const previous = retry?.payload === payload ? retry : null;
      const input: ChangeProposalInput = previous?.input ?? {
        ...fields,
        expectedVersion: (
          await api<{ latestRecordedVersion: number }>(`/records/${record}/change-context`)
        ).latestRecordedVersion,
      };
      const key = previous?.key ?? crypto.randomUUID();
      setRetry({ payload, key, input });
      const value = await api<ChangeRequestStatus>(
        `/records/${record}/change-requests`,
        input,
        key,
      );
      remember(value.requestId);
      setResult(value);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Propose a record correction"
      subtitle="Registrar access · A different registrar must review. Saving a proposal does not change the grade."
    >
      {error && <Alert>{error}</Alert>}
      <form onSubmit={(e) => void propose(e)}>
        <div className="form-grid">
          <Field label="Evidence ID">
            <input
              name="evidence"
              key={evidence}
              defaultValue={evidence}
              required
              pattern={idPattern}
              placeholder="Available evidence bound to this record"
            />
          </Field>
          <Field label="Outcome">
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as GradeOutcome)}>
              {['passed', 'failed', 'withdrawn', 'incomplete'].map((v) => (
                <option value={v} key={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Grade points">
            <input
              name="points"
              type="number"
              min="0"
              max="99.99"
              step="0.01"
              required={!['withdrawn', 'incomplete'].includes(outcome)}
              disabled={['withdrawn', 'incomplete'].includes(outcome)}
              placeholder="8.00"
            />
          </Field>
          <Field label="Effective from (local time)">
            <input name="from" type="datetime-local" required />
          </Field>
          <Field label="Effective until (optional, local time)">
            <input name="until" type="datetime-local" />
          </Field>
          <Field label="Reason for correction">
            <textarea name="reason" required maxLength={500} rows={2} />
          </Field>
        </div>
        <button className="primary" disabled={busy || !record}>
          {busy ? 'Submitting…' : 'Submit for independent review'}
          <Icon name="arrow" />
        </button>
      </form>
      {result && (
        <div className="success" role="status">
          <strong>Proposal submitted · awaiting independent review</strong>
          <p>
            Request ID: <code>{result.requestId}</code>
          </p>
          <p>
            Expected version: {result.expectedVersion}. Open Review and share this ID with the
            second registrar.
          </p>
        </div>
      )}
    </Panel>
  );
}
