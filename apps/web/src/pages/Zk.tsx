import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TranscriptResponse } from '@scholarproof/contracts';
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
import { request, message } from '../api.js';
import { Panel, Field, Alert, Badge } from '../ui.js';
import { idPattern } from '../format.js';
interface ZkConfig {
  profile: string;
  setup: string;
  issuer: string;
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
export function Zk({ api, records }: { api: Api; records: TranscriptResponse['records'] }) {
  const [record, setRecord] = useState(''),
    [threshold, setThreshold] = useState('8.00'),
    [wallet, setWallet] = useState<Wallet | null>(null),
    [bundle, setBundle] = useState<PublicProof | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<{ record: string; id: string; secret: string; holder: string } | null>(
      null,
    ),
    worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  async function issue(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    setBundle(null);
    try {
      if (pending.current?.record !== record) {
        const secret = privateScalar();
        pending.current = {
          record,
          id: crypto.randomUUID(),
          secret,
          holder: await holderCommitment(secret),
        };
      }
      const input = pending.current!;
      const issued = await api<Omit<Wallet, 'secret'>>(`/zk/records/${record}/credentials`, {
        credentialId: input.id,
        holder: input.holder,
      });
      setWallet({ ...issued, secret: input.secret });
      pending.current = null;
    } catch (e) {
      setError(message(e));
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
          The holder secret and proof generation stay in this browser. Only the proof and public
          threshold are shared. This uses the latest recorded approved version, which may differ
          from today's effective result.
        </p>
        <Badge tone="amber">Local development ceremony</Badge>
      </Panel>
      {error && <Alert>{error}</Alert>}
      <div className="two-col">
        <Panel
          title="1 · Create a proof credential"
          subtitle="Choose a current, independently approved passed course result."
        >
          <form onSubmit={(e) => void issue(e)}>
            <Field label="Approved record">
              <select
                required
                value={record}
                onChange={(e) => setRecord(e.target.value)}
                disabled={busy}
              >
                <option value="" disabled>
                  Choose an approved record
                </option>
                {records
                  .filter((r) => r.grade_points !== null && r.outcome === 'passed')
                  .map((r) => (
                    <option key={r.record_id} value={r.record_id}>
                      {r.course_code} · version {r.version_no}
                    </option>
                  ))}
              </select>
            </Field>
            <button className="primary" disabled={busy}>
              {busy ? 'Working…' : 'Issue private proof credential'}
            </button>
          </form>
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
          title="2 · Consent and generate proof"
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
                onChange={(e) => setThreshold(e.target.value)}
                disabled={busy}
              />
            </Field>
            <p className="muted">
              Generating this proof consents to sharing the selected threshold and linkable
              credential/record identifiers. It does not send the exact grade or wallet secret.
            </p>
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
              <p>Share this proof promptly: its online challenge expires after two minutes.</p>
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
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{
      status: string;
      threshold: string;
      credentialId: string;
      receipt: string;
      versionNo: number;
    } | null>(null);
  async function verify(event: FormEvent) {
    event.preventDefault();
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const bundle = JSON.parse(source) as PublicProof;
      const config = await request<ZkConfig>('/zk/config');
      if (
        bundle.profile !== config.profile ||
        !(await verifyEligibility(bundle, bundle.statement, config.verificationKey))
      )
        throw new Error('The zero-knowledge proof is invalid.');
      const issued = await jwtVerify(bundle.artifact, await importJWK(config.publicKey, 'EdDSA'), {
        issuer: config.issuer,
        algorithms: ['EdDSA'],
        typ: 'academic-eligibility+jwt',
      });
      if (
        issued.payload.commitment !== bundle.statement.commitment ||
        issued.payload.holder !== bundle.statement.holder ||
        issued.payload.context !== bundle.statement.context ||
        issued.payload.maximum !== bundle.statement.maximum
      )
        throw new Error('Proof does not match the issued credential.');
      const value = await request<NonNullable<typeof result>>('/zk/verify', undefined, {
        challengeId: bundle.challengeId,
        proof: bundle.proof,
        publicSignals: bundle.publicSignals,
      });
      const receipt = await jwtVerify(value.receipt, await importJWK(config.publicKey, 'EdDSA'), {
        issuer: config.issuer,
        algorithms: ['EdDSA'],
        typ: 'academic-eligibility-result+jwt',
      });
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
        receipt.payload.nullifier !== bundle.publicSignals[0]
      )
        throw new Error('Acceptance receipt does not match this challenge.');
      setResult(value);
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? 'Paste a valid shareable proof JSON file.'
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
          <span className="eyebrow dark">PRIVATE ELIGIBILITY VERIFICATION</span>
          <h1>Proof, without the grade.</h1>
          <p>Verify a shared grade-threshold proof and its current academic status.</p>
        </div>
      </div>
      <Panel
        title="Verify a shared proof"
        subtitle="Upload the shareable proof only. Never request or upload a student's private wallet."
      >
        <Badge tone="amber">Local development ceremony</Badge>
        <form onSubmit={(e) => void verify(e)}>
          <Field label="Shareable proof file">
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void file.text().then(setSource);
              }}
            />
          </Field>
          <Field label="Shareable proof JSON">
            <textarea
              required
              rows={10}
              maxLength={20000}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={busy}
            />
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? 'Checking proof & current status…' : 'Verify proof'}
          </button>
        </form>
      </Panel>
      {error && <Alert>{error}</Alert>}
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
