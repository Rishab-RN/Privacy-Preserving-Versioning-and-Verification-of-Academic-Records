import { useState } from 'react';
import type { FormEvent } from 'react';
import { Brand, Icon, Alert, Field } from '../ui.js';
import { message } from '../api.js';
const sampleStages = [
  {
    label: 'Record',
    icon: 'Records',
    figure: 'v01',
    title: 'Original result',
    detail: 'A later revision keeps the original version available.',
  },
  {
    label: 'Revision',
    icon: 'Review',
    figure: 'v02',
    title: 'Approved correction',
    detail: 'A different registrar reviews the proposed change before it takes effect.',
  },
  {
    label: 'Proof',
    icon: 'Private proofs',
    figure: '≥ 8.00',
    title: 'Private eligibility claim',
    detail: 'A verifier can check a grade threshold while the exact grade stays private.',
  },
] as const;
export function Login({
  login,
  notice,
}: {
  login: (subject: string, password: string) => Promise<void>;
  notice: string;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [showPassword, setShowPassword] = useState(false),
    [stage, setStage] = useState(0);
  const example = sampleStages[stage]!;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await login(String(form.get('subject')).trim(), String(form.get('password')));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <section className="login-story">
        <Brand />
        <div className="story-copy">
          <h1>
            Academic records
            <br />
            <em>through time.</em>
          </h1>
          <p>See how a correction was approved and share what a verifier needs.</p>
          <div className="record-atlas" aria-label="Interactive example record trail">
            <div className="atlas-plot" aria-hidden="true">
              <div className="atlas-sheet atlas-sheet-back" />
              <div className="atlas-sheet atlas-sheet-middle" />
              <div className="atlas-sheet atlas-sheet-front">
                <Icon name={example.icon} />
                <span className="atlas-figure">{example.figure}</span>
                <span className="atlas-lines" />
              </div>
              <span className="atlas-axis atlas-axis-top">01</span>
              <span className="atlas-axis atlas-axis-bottom">03</span>
            </div>
            <div className="atlas-metadata">
              <p className="workspace-label">Example record trail</p>
              <div className="atlas-stages" role="group" aria-label="Example stage">
                {sampleStages.map((item, index) => (
                  <button
                    type="button"
                    key={item.label}
                    aria-pressed={stage === index}
                    onClick={() => setStage(index)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="atlas-detail" aria-live="polite">
                <strong>{example.title}</strong>
                <p>{example.detail}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <main className="login-main">
        <div className="login-card">
          <h2>Welcome back.</h2>
          <p className="muted">Sign in with your assigned academic account.</p>
          {notice && <Alert>{notice}</Alert>}
          {error && <Alert>{error}</Alert>}
          <form onSubmit={(e) => void submit(e)}>
            <Field
              label="Account ID"
              hint="Use the account subject provided by your administrator."
            >
              <input
                name="subject"
                required
                maxLength={80}
                autoComplete="username"
                placeholder="Your account ID"
                disabled={busy}
              />
            </Field>
            <Field label="Password">
              <input
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                maxLength={128}
                autoComplete="current-password"
                placeholder="Your password"
                disabled={busy}
              />
            </Field>
            <button
              type="button"
              className="password-visibility"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((shown) => !shown)}
            >
              {showPassword ? 'Hide password' : 'Show password'}
            </button>
            <button className="primary full" disabled={busy}>
              {busy ? (
                'Signing in…'
              ) : (
                <>
                  Sign in to workspace <Icon name="arrow" />
                </>
              )}
            </button>
          </form>
          <p className="login-help">Need access? Contact your institution’s administrator.</p>
          <a className="verifier-entry" href="/verify">
            <span className="action-icon">
              <Icon name="Private proofs" />
            </span>
            <span>
              <strong>Verify a shared proof</strong>
              <small>Open the public verifier</small>
            </span>
            <Icon name="arrow" />
          </a>
        </div>
      </main>
    </div>
  );
}
