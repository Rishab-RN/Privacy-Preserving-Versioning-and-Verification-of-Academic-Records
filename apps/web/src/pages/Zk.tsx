import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { EligibleProofRecord } from '@scholarproof/contracts';
import type { EligibilityProof, PublicStatement } from '@academic-records/zk/browser';
import {
  field,
  fixedPoints,
  privateScalar,
  holderCommitment,
  verifyEligibility,
} from '@academic-records/zk/browser';
import { importJWK, jwtVerify } from 'jose';
import type { JWK } from 'jose';
import type { Api } from '../types.js';
import { request, message, RequestFailure } from '../api.js';
import { Panel, Field, Alert, Badge, Icon } from '../ui.js';
import { idPattern } from '../format.js';
interface ZkConfig {
  profile: string;
  setup: string;
  issuer: string;
  audience: string;
  verificationKeyHash: string;
  publicKey: JWK;
  verificationKey: unknown;
  wasmHash: string;
  provingKeyHash: string;
}
interface Wallet {
  credentialId: string;
  recordId: string;
  versionNo: number;
  artifact: string;
  grade: string;
  salt: string;
  holder: string;
  secret: string;
  status: string;
}
interface Challenge {
  challengeId: string;
  artifact: string;
  statement: PublicStatement;
  expiresAt: string;
}
interface PublicProof extends EligibilityProof {
  profile: string;
  challengeId: string;
  artifact: string;
  statement: PublicStatement;
}
interface Acceptance {
  status: string;
  threshold: string;
  credentialId: string;
  receipt: string;
  versionNo: number;
  verifiedAt: string;
}
interface IssuanceHistory {
  status: 'anchored';
  treeSize: number;
  checkpointAt: string;
  eventId: string;
  versionNo: number;
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Zk({ api, studentId }: { api: Api; studentId: string }) {
  const [record, setRecord] = useState(''),
    [threshold, setThreshold] = useState('8.00'),
    [wallet, setWallet] = useState<Wallet | null>(null),
    [bundle, setBundle] = useState<PublicProof | null>(null),
    [expiresAt, setExpiresAt] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [eligible, setEligible] = useState<EligibleProofRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(Boolean(studentId));
  const [listError, setListError] = useState('');
  const [listRequest, refreshList] = useState(0);
  const pending = useRef<{
      record: string;
      versionNo: number;
      id: string;
      secret: string;
      holder: string;
    } | null>(null),
    worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => {
    if (!studentId) return;
    let active = true;
    void api<{ records: EligibleProofRecord[] }>(`/zk/students/${studentId}/eligible-records`)
      .then(({ records }) => {
        if (active) setEligible(records);
      })
      .catch((failure: unknown) => {
        if (active) setListError(message(failure));
      })
      .finally(() => {
        if (active) setLoadingRecords(false);
      });
    return () => {
      active = false;
    };
  }, [studentId, listRequest]);
  function reloadRecords() {
    setRecord('');
    setEligible([]);
    setListError('');
    setLoadingRecords(true);
    refreshList((previous) => previous + 1);
  }
  async function issue(event: FormEvent) {
    event.preventDefault();
    const selected = eligible.find((entry) => entry.recordId === record);
    if (!selected) return;
    setError('');
    setBusy(true);
    setBundle(null);
    try {
      if (pending.current?.record !== record || pending.current.versionNo !== selected.versionNo) {
        const secret = privateScalar();
        pending.current = {
          record,
          versionNo: selected.versionNo,
          id: crypto.randomUUID(),
          secret,
          holder: await holderCommitment(secret),
        };
      }
      const input = pending.current!;
      const issued = await api<Omit<Wallet, 'secret'>>(`/zk/records/${record}/credentials`, {
        credentialId: input.id,
        holder: input.holder,
        expectedVersion: input.versionNo,
      });
      setWallet({ ...issued, secret: input.secret });
      pending.current = null;
    } catch (e) {
      setError(message(e));
      if (e instanceof RequestFailure && e.code === 'VERSION_CONFLICT') {
        pending.current = null;
        reloadRecords();
      }
    } finally {
      setBusy(false);
    }
  }
  async function prove(event: FormEvent) {
    event.preventDefault();
    if (!wallet) return;
    setBusy(true);
    setError('');
    setBundle(null);
    try {
      const points = fixedPoints(threshold);
      if (BigInt(points) > BigInt(wallet.grade))
        throw new Error('This grade does not satisfy the selected threshold.');
      const config = await api<ZkConfig>('/zk/config');
      const challenge = await api<Challenge>(`/zk/credentials/${wallet.credentialId}/challenges`, {
        threshold: Number(points),
      });
      const key = await importJWK(config.publicKey, 'EdDSA');
      await jwtVerify(wallet.artifact, key, {
        issuer: config.issuer,
        algorithms: ['EdDSA'],
        typ: 'academic-eligibility+jwt',
      });
      const instance = new Worker(new URL('../zk.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      const result = await new Promise<EligibilityProof>((yes, no) => {
        const timer = setTimeout(() => {
          instance.terminate();
          no(new Error('Proof generation timed out. Request a fresh challenge.'));
        }, 90000);
        instance.onmessage = (
          event: MessageEvent<{ bundle?: EligibilityProof; error?: string }>,
        ) => {
          clearTimeout(timer);
          instance.terminate();
          if (event.data.bundle) yes(event.data.bundle);
          else no(new Error(event.data.error ?? 'Proof failed'));
        };
        instance.onerror = () => {
          clearTimeout(timer);
          instance.terminate();
          no(new Error('The browser proof worker failed.'));
        };
        instance.postMessage({
          statement: challenge.statement,
          witness: { grade: wallet.grade, salt: wallet.salt, secret: wallet.secret },
          wasmHash: config.wasmHash,
          provingKeyHash: config.provingKeyHash,
        });
      });
      setBundle({
        profile: config.profile,
        challengeId: challenge.challengeId,
        artifact: challenge.artifact,
        statement: challenge.statement,
        ...result,
      });
      setExpiresAt(challenge.expiresAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Proof generation failed');
    } finally {
      worker.current = null;
      setBusy(false);
    }
  }
  async function importWallet(file: File) {
    try {
      const value = JSON.parse(await file.text()) as Wallet;
      if (
        !new RegExp('^' + idPattern + '$').test(value.credentialId) ||
        !value.artifact ||
        [value.grade, value.salt, value.secret, value.holder].some((v) => field(v) !== v) ||
        (await holderCommitment(value.secret)) !== value.holder
      )
        throw new Error('Invalid private wallet');
      setWallet(value);
      setBundle(null);
      setError('');
    } catch {
      setError('The private wallet is invalid.');
    }
  }
  return (
    <>
      <Panel
        title="Prove a grade threshold privately"
        subtitle="Prove that an approved course grade meets a minimum, without sharing the exact grade."
      >
        <p className="muted">
          The holder secret and proof generation stay in this browser. This uses the latest recorded
          approved version, which may differ from today's effective result.
        </p>
        <Badge tone="amber">Local development ceremony</Badge>
      </Panel>
      {error && <Alert>{error}</Alert>}
      <div className="two-col">
        <Panel
          title="Create a proof credential"
          subtitle="Choose a current, independently approved passed course result."
        >
          {listError && <Alert>{listError}</Alert>}
          {!loadingRecords && !listError && !eligible.length && (
            <p>No independently approved passed results are available for proof issuance.</p>
          )}
          <form onSubmit={(e) => void issue(e)}>
            <Field label="Approved record">
              <select
                required
                value={record}
                onChange={(e) => setRecord(e.target.value)}
                disabled={busy || loadingRecords || !eligible.length}
              >
                <option value="" disabled>
                  {loadingRecords ? 'Loading eligible records…' : 'Choose an approved record'}
                </option>
                {eligible.map((r) => (
                  <option key={r.recordId} value={r.recordId}>
                    {r.courseCode} · version {r.versionNo}
                  </option>
                ))}
              </select>
            </Field>
            <button className="primary" disabled={busy || loadingRecords || !record}>
              {busy ? 'Working…' : 'Issue private proof credential'}
            </button>
          </form>
          {studentId && (
            <button
              type="button"
              className="text-button"
              onClick={reloadRecords}
              disabled={busy || loadingRecords}
            >
              Refresh eligible records
            </button>
          )}
          <Field label="Restore private wallet">
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importWallet(file);
              }}
            />
          </Field>
          {wallet && (
            <div className="success" role="status">
              <strong>Proof credential issued</strong>
              <p>
                Credential ID: <code>{wallet.credentialId}</code>
              </p>
              <p>
                Record version {wallet.versionNo} · {wallet.status}
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  download('private-grade-wallet-' + wallet.credentialId + '.json', wallet)
                }
              >
                Download private wallet
              </button>
              <p>
                Keep this wallet private. It contains your grade and secret; never share it with a
                verifier. Download it before leaving this page: navigating away or reloading clears
                the wallet from browser memory.
              </p>
            </div>
          )}
        </Panel>
        <Panel
          title="Preview and generate proof"
          subtitle="Each proof is bound to a fresh, single-use verifier challenge."
        >
          <form onSubmit={(e) => void prove(e)}>
            <Field label="Minimum grade points">
              <input
                type="number"
                min="0"
                max="99.99"
                step="0.01"
                required
                value={threshold}
                onChange={(e) => {
                  setThreshold(e.target.value);
                  setBundle(null);
                }}
                disabled={busy}
              />
            </Field>
            {wallet && (
              <details open className="disclosure-preview">
                <summary>What the proof file shares</summary>
                <dl>
                  <dt>Minimum grade points</dt>
                  <dd>{threshold || 'Enter a threshold'}</dd>
                  <dt>Credential and record IDs</dt>
                  <dd>
                    <code>{wallet.credentialId}</code>
                    <br />
                    <code>{wallet.recordId}</code>
                  </dd>
                  <dt>Record version</dt>
                  <dd>{wallet.versionNo}</dd>
                  <dt>Verification data</dt>
                  <dd>
                    Issuer and institution identifiers, signed commitment and holder commitment,
                    grading maximum, one-use challenge, Groth16 proof and public signals.
                  </dd>
                  <dt>Private wallet</dt>
                  <dd>Exact grade, blinding salt and holder secret stay private.</dd>
                </dl>
              </details>
            )}
            <button className="primary" disabled={busy || !wallet}>
              {busy ? 'Generating proof locally…' : 'Consent & generate ZK proof'}
            </button>
          </form>
          {bundle && (
            <div className="success" role="status">
              <strong>Zero-knowledge proof generated</strong>
              <p>
                Exact grade hidden · minimum {Number(bundle.statement.threshold) / 100} grade
                points.
              </p>
              <button
                className="secondary"
                onClick={() => download('grade-threshold-proof.json', bundle)}
              >
                Download shareable proof
              </button>
              <p>
                Online challenge expires at{' '}
                <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleTimeString()}</time>.
              </p>
              <a href="/verify" target="_blank" rel="noreferrer">
                Open verifier workspace ↗
              </a>
              <details>
                <summary>Inspect public proof JSON</summary>
                <pre className="proof-json">{JSON.stringify(bundle, null, 2)}</pre>
              </details>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
export function ProofVerifier() {
  const [source, setSource] = useState(''),
    [historySource, setHistorySource] = useState(''),
    [history, setHistory] = useState<IssuanceHistory | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Acceptance | null>(null),
    [onlineState, setOnlineState] = useState(''),
    [dragging, setDragging] = useState(false);
  function resetResults() {
    setError('');
    setHistory(null);
    setResult(null);
    setOnlineState('');
  }
  async function loadFile(file: File, setValue: (value: string) => void) {
    resetResults();
    setValue('');
    if (file.size > 20000) {
      setError('Choose a JSON file smaller than 20 KB.');
      return;
    }
    setBusy(true);
    try {
      setValue(await file.text());
    } catch {
      setError('The file could not be read.');
    } finally {
      setBusy(false);
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const historyOnly = submitter?.getAttribute('value') === 'history';
    resetResults();
    setBusy(true);
    let checkingOnline = false;
    try {
      const bundle = JSON.parse(source) as PublicProof;
      if (typeof bundle?.artifact !== 'string' || !bundle.statement || !bundle.proof)
        throw new Error('Choose the shareable proof file from the student workspace.');
      if (historySource.trim()) {
        const checked = await request<IssuanceHistory>('/zk/verify-history', undefined, {
          artifact: bundle.artifact,
          history: JSON.parse(historySource) as unknown,
        });
        setHistory(checked);
      }
      if (historyOnly) return;
      checkingOnline = true;
      const config = await request<ZkConfig>('/zk/config');
      if (
        bundle.profile !== config.profile ||
        !(await verifyEligibility(bundle, bundle.statement, config.verificationKey))
      )
        throw new Error('The zero-knowledge proof is invalid.');
      const issuerKey = await importJWK(config.publicKey, 'EdDSA');
      const issued = await jwtVerify(bundle.artifact, issuerKey, {
        issuer: config.issuer,
        algorithms: ['EdDSA'],
        typ: 'academic-eligibility+jwt',
      });
      if (
        issued.payload.commitment !== bundle.statement.commitment ||
        issued.payload.holder !== bundle.statement.holder ||
        issued.payload.context !== bundle.statement.context ||
        issued.payload.maximum !== bundle.statement.maximum ||
        issued.payload.profile !== config.profile ||
        issued.payload.vkHash !== config.verificationKeyHash
      )
        throw new Error('Proof does not match the issued credential.');
      const value = await request<Acceptance>('/zk/verify', undefined, {
        challengeId: bundle.challengeId,
        proof: bundle.proof,
        publicSignals: bundle.publicSignals,
      });
      const receipt = await jwtVerify(value.receipt, issuerKey, {
        issuer: config.issuer,
        algorithms: ['EdDSA'],
        typ: 'academic-eligibility-result+jwt',
      });
      const artifactBytes = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundle.artifact)),
      );
      const artifactHash = Array.from(artifactBytes, (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (
        receipt.payload.challengeId !== bundle.challengeId ||
        receipt.payload.status !== 'current' ||
        value.status !== 'current' ||
        receipt.payload.credentialId !== value.credentialId ||
        receipt.payload.credentialId !== issued.payload.credentialId ||
        receipt.payload.versionNo !== value.versionNo ||
        receipt.payload.versionNo !== issued.payload.versionNo ||
        receipt.payload.threshold !== value.threshold ||
        receipt.payload.threshold !== bundle.statement.threshold ||
        receipt.payload.nullifier !== bundle.publicSignals[0] ||
        receipt.payload.profile !== config.profile ||
        receipt.payload.audience !== config.audience ||
        receipt.payload.recordId !== issued.payload.recordId ||
        receipt.payload.artifactDigest !== artifactHash ||
        receipt.payload.verifiedAt !== value.verifiedAt ||
        !Number.isFinite(Date.parse(value.verifiedAt))
      )
        throw new Error('Acceptance receipt does not match this challenge.');
      setResult(value);
    } catch (e) {
      if (checkingOnline) {
        if (e instanceof RequestFailure && (e.status === 0 || e.status >= 500))
          setOnlineState('Current status unavailable');
        else if (e instanceof RequestFailure && e.code === 'CREDENTIAL_REVOKED')
          setOnlineState('Credential revoked');
        else if (e instanceof RequestFailure && e.code === 'CREDENTIAL_SUPERSEDED')
          setOnlineState('Credential superseded by a newer version');
        else setOnlineState('Online verification rejected');
      }
      setError(
        e instanceof SyntaxError
          ? 'The proof or issuance evidence is not valid JSON.'
          : e instanceof Error
            ? e.message
            : 'Verification failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="public-verifier">
      <a href="/">← Sign-in workspace</a>
      <div className="page-heading">
        <div>
          <p className="workspace-label">Public verifier</p>
          <h1>Verify a private grade proof</h1>
          <p>Check a grade threshold, issuance history and current academic status.</p>
        </div>
      </div>
      <Panel
        title="Verify a shared proof"
        subtitle="Upload the shareable proof only. Never request or upload a student's private wallet."
      >
        <Badge tone="amber">Local development ceremony</Badge>
        <form onSubmit={(e) => void verify(e)}>
          <div
            className={`proof-drop${dragging ? ' is-dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file && !busy) void loadFile(file, setSource);
            }}
          >
            <Icon name="Evidence" />
            <Field label="Shareable proof file" hint="Choose or drop the JSON proof file here.">
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadFile(file, setSource);
                }}
              />
            </Field>
          </div>
          <Field label="Shareable proof JSON">
            <textarea
              required
              rows={5}
              maxLength={20000}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                resetResults();
              }}
              disabled={busy}
            />
          </Field>
          <Field
            label="Signed issuance evidence (optional)"
            hint="Use the issuance JSON from the log operator to check the credential's signed history."
          >
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file, setHistorySource);
                else {
                  setHistorySource('');
                  resetResults();
                }
              }}
            />
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? 'Checking proof & current status…' : 'Verify proof'}
          </button>{' '}
          <button
            className="secondary"
            type="submit"
            value="history"
            disabled={busy || !historySource}
          >
            Check signed history only
          </button>
        </form>
      </Panel>
      {error && <Alert>{error}</Alert>}
      {(history || result || onlineState) && (
        <Panel title="Historical issuance">
          {history ? (
            <p role="status">
              Included in signed history · version {history.versionNo} · checkpoint size{' '}
              {history.treeSize} at{' '}
              <time dateTime={history.checkpointAt}>
                {new Date(history.checkpointAt).toLocaleString()}
              </time>
              .
            </p>
          ) : (
            <p>Signed issuance evidence was not supplied.</p>
          )}
        </Panel>
      )}
      {onlineState && <p role="status">{onlineState}</p>}
      {result && (
        <div className="success" role="status">
          <strong>Verified · threshold met</strong>
          <p>
            At least {(Number(result.threshold) / 100).toFixed(2)} grade points · exact grade not
            disclosed.
          </p>
          <p>
            Record version {result.versionNo} · credential {result.status} at acceptance · challenge
            consumed.
          </p>
          <p>
            Current status checked at{' '}
            <time dateTime={result.verifiedAt}>{new Date(result.verifiedAt).toLocaleString()}</time>
            .
          </p>
          <p>
            Credential: <code>{result.credentialId}</code>
          </p>
          <button
            className="secondary"
            onClick={() => download('signed-eligibility-receipt.json', result)}
          >
            Download signed acceptance receipt
          </button>
          <p>
            This is an as-of acceptance result. Future revocation requires a fresh online check.
          </p>
        </div>
      )}
    </main>
  );
}
