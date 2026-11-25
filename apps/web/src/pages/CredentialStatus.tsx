import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Api } from '../types.js';
import { message } from '../api.js';
import { Panel, Field, Alert } from '../ui.js';
import { idPattern } from '../format.js';

export function CredentialStatus({ api }: { api: Api }) {
  const [credentialId, setCredentialId] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [revoked, setRevoked] = useState(''),
    [busy, setBusy] = useState(false);
  async function revoke(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setRevoked('');
    try {
      await api(`/zk/credentials/${credentialId}/revoke`, { reason });
      setRevoked(credentialId);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Revoke a private proof credential" subtitle="Institution-scoped registrar action">
      <p className="muted">
        Revocation is permanent for this credential. It preserves the issued artifact and academic
        record, and blocks future online acceptance. Enter the credential ID shared by the holder.
      </p>
      <form onSubmit={(event) => void revoke(event)}>
        <Field label="Credential ID">
          <input
            required
            pattern={idPattern}
            value={credentialId}
            onChange={(event) => setCredentialId(event.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Revocation reason">
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
          />
        </Field>
        <button className="primary" disabled={busy || !reason.trim()}>
          {busy ? 'Recording revocation…' : 'Revoke credential permanently'}
        </button>
      </form>
      {error && <Alert>{error}</Alert>}
      {revoked && (
        <div className="success" role="status">
          <strong>Credential revoked</strong>
          <p>
            <code>{revoked}</code>
          </p>
          <p>Future online proof acceptance is blocked. Historical issuance remains verifiable.</p>
        </div>
      )}
    </Panel>
  );
}
