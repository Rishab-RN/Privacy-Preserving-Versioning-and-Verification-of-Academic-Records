import { useRef, useState } from 'react';
import type { CorrectionIntegrity as Result } from '@scholarproof/contracts';
import type { Api } from '../types.js';
import { message } from '../api.js';
import { Alert, Badge, Field, Panel } from '../ui.js';

const eventLabels: Record<Result['event'], string> = {
  verified: 'Signed proof matches the SQL event',
  'invalid-proof': 'Invalid signed proof',
  'journal-mismatch': 'SQL journal integrity failure',
  'not-approved': 'Approval proof unavailable',
  'key-unavailable': 'Trusted log key unavailable',
};
const witnessLabels: Record<Result['witness'], string> = {
  unchecked: 'Witness comparison incomplete',
  unavailable: 'Retained witness unavailable',
  matched: 'Matches retained checkpoint',
  extended: 'Extends retained checkpoint',
  'older-export': 'Proof predates retained checkpoint',
  'split-view': 'Conflicting signed checkpoints',
  'invalid-consistency': 'Invalid checkpoint extension',
  'journal-behind-witness': 'SQL journal behind retained checkpoint',
};

export function CorrectionIntegrity({
  api,
  requestId,
  eventId,
}: {
  api: Api;
  requestId: string;
  eventId: string | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  async function verify() {
    if (!file) return;
    setResult(null);
    if (file.size === 0 || file.size > 16 * 1024) {
      setError('Choose a proof file up to 16 KiB.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      setResult(
        await api<Result>(`/change-requests/${requestId}/integrity`, {
          bundle: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            await file.arrayBuffer(),
          ),
        }),
      );
    } catch (reason) {
      setError(
        reason instanceof TypeError ? 'The proof file must contain UTF-8 JSON.' : message(reason),
      );
    } finally {
      // Each verification requires an explicit file selection.
      setFile(null);
      if (picker.current) picker.current.value = '';
      setBusy(false);
    }
  }
  const witnessFailure =
    result &&
    ['split-view', 'invalid-consistency', 'journal-behind-witness'].includes(result.witness);
  const eventFailure = result?.event === 'invalid-proof' || result?.event === 'journal-mismatch';
  return (
    <Panel
      title="Correction integrity"
      subtitle="Check a signed approval proof against the recorded event and the retained checkpoint."
    >
      {eventId && (
        <p className="muted">
          Approval event <code>{eventId}</code>
        </p>
      )}
      <form
        className="integrity-form"
        onSubmit={(event) => {
          event.preventDefault();
          void verify();
        }}
      >
        <Field
          label="Signed approval proof file"
          hint="Use the original JSON export for this approval."
        >
          <input
            ref={picker}
            type="file"
            accept=".json,application/json"
            required
            disabled={busy}
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setResult(null);
              setError('');
            }}
          />
        </Field>
        <button type="submit" className="primary" disabled={!file || busy}>
          {busy ? 'Checking proof…' : 'Check signed approval'}
        </button>
      </form>
      {error && <Alert>{error}</Alert>}
      {(eventFailure || witnessFailure) && <Alert>Verification found an integrity failure.</Alert>}
      {result && (
        <div className="integrity-result" role="status">
          <div>
            <h3>Event integrity</h3>
            <Badge tone={result.event === 'verified' ? 'green' : eventFailure ? 'red' : 'amber'}>
              {eventLabels[result.event]}
            </Badge>
            {result.checkpointSize !== null && (
              <p>Proof checkpoint covers {result.checkpointSize} positions.</p>
            )}
          </div>
          <div>
            <h3>Checkpoint witness</h3>
            <Badge
              tone={
                witnessFailure
                  ? 'red'
                  : result.witness === 'matched' || result.witness === 'extended'
                    ? 'green'
                    : 'amber'
              }
            >
              {witnessLabels[result.witness]}
            </Badge>
            <p>
              SQL journal covers {result.committed} positions.
              {result.retainedSize !== null && <> Witness retained {result.retainedSize}.</>}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
