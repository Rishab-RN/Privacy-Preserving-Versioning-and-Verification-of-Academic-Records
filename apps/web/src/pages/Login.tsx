import { useState } from 'react';
import type { FormEvent } from 'react';
import { Brand, Icon, Alert, Field } from '../ui.js';
import { message } from '../api.js';
export function Login({
  login,
  notice,
}: {
  login: (subject: string, password: string) => Promise<void>;
  notice: string;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
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
          <span className="eyebrow">A RECORD YOU CAN TRUST</span>
          <h1>
            Every revision.
            <br />A clearer history.
          </h1>
          <p>
            A private workspace for academic records, supporting evidence and carefully reviewed
            corrections.
          </p>
          <div className="story-ledger">
            <div>
              <span>01</span>
              <strong>Preserve the original</strong>
              <p>Keep earlier academic answers available.</p>
            </div>
            <div>
              <span>02</span>
              <strong>Review every change</strong>
              <p>Independent approval before a correction is applied.</p>
            </div>
            <div>
              <span>03</span>
              <strong>Share with care</strong>
              <p>Access is scoped to your role and institution.</p>
            </div>
          </div>
        </div>
        <p className="story-footer">
          Privacy-Preserving Versioning and Verification of Academic Records
        </p>
      </section>
      <main className="login-main">
        <div className="login-card">
          <span className="overline">
            <Icon name="lock" /> SECURE WORKSPACE
          </span>
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
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
                placeholder="Your password"
                disabled={busy}
              />
            </Field>
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
          <p className="login-help">
            <a href="/verify">Verify a shared zero-knowledge proof ↗</a>
          </p>
          <div className="login-assurance">
            <Icon name="lock" />
            <span>
              Your session stays in memory on this device.
              <br />
              Refresh or sign out to clear it.
            </span>
          </div>
        </div>
        <p className="login-bottom">ACADEMIC INTEGRITY, WITH PRIVACY BUILT IN.</p>
      </main>
    </div>
  );
}
