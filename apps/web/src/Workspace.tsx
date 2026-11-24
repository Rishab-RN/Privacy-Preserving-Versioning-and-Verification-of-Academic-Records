import { useState, useEffect, useRef } from 'react';
import type { StudentSummary, TranscriptResponse, EvidenceReceipt } from '@scholarproof/contracts';
import type { Api, Page, Session } from './types.js';
import { Brand, Icon, Badge, Field, Alert, Panel } from './ui.js';
import { date } from './format.js';
import { message } from './api.js';
import { RecordsTable } from './pages/RecordsTable.js';
import { Evidence } from './pages/Evidence.js';
import { Review } from './pages/Review.js';
export function Workspace({
  session,
  api,
  logout,
}: {
  session: Session;
  api: Api;
  logout: () => Promise<void>;
}) {
  const [page, setPage] = useState<Page>('Overview'),
    [students, setStudents] = useState<StudentSummary[]>([]),
    [student, setStudent] = useState(''),
    [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<EvidenceReceipt | null>(null),
    [recent, setRecent] = useState<string[]>([]),
    [activeRequest, setActiveRequest] = useState('');
  const registrar = session.principal.roles.some((r) => r.role === 'registrar'),
    canEvidence = session.principal.roles.some((r) => ['registrar', 'student'].includes(r.role));
  const canReview = session.principal.roles.some((r) => ['registrar', 'auditor'].includes(r.role));
  const pages: Page[] = [
    'Overview',
    'Records',
    ...(canEvidence ? ['Evidence' as const] : []),
    ...(canReview ? ['Review' as const] : []),
  ];
  const transcriptRequest = useRef(0);
  useEffect(() => {
    let active = true;
    void api<{ students: StudentSummary[] }>('/students')
      .then((result) => {
        if (active) {
          setStudents(result.students);
          setStudent(result.students[0]?.studentId ?? '');
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!student) return;
    const generation = ++transcriptRequest.current;
    let active = true;
    setLoading(true);
    setError('');
    setTranscript(null);
    void api<TranscriptResponse>(`/students/${student}/transcript`)
      .then((value) => {
        if (active && generation === transcriptRequest.current) setTranscript(value);
      })
      .catch((e) => {
        if (active && generation === transcriptRequest.current) setError(message(e));
      })
      .finally(() => {
        if (active && generation === transcriptRequest.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [student]);
  const records = transcript?.records ?? [];
  async function loadTranscript(knownAt?: string, effectiveAt?: string) {
    if (!student) return;
    const generation = ++transcriptRequest.current;
    setLoading(true);
    setError('');
    setTranscript(null);
    try {
      const params = new URLSearchParams();
      if (knownAt) params.set('knownAt', new Date(knownAt).toISOString());
      if (effectiveAt) params.set('effectiveAt', new Date(effectiveAt).toISOString());
      const value = await api<TranscriptResponse>(`/students/${student}/transcript?${params}`);
      if (generation === transcriptRequest.current) setTranscript(value);
    } catch (e) {
      if (generation === transcriptRequest.current) setError(message(e));
    } finally {
      if (generation === transcriptRequest.current) setLoading(false);
    }
  }
  function remember(id: string) {
    setRecent((ids) => [id, ...ids.filter((i) => i !== id)].slice(0, 20));
    setActiveRequest(id);
  }
  return (
    <div className="workspace">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {pages.map((name) => (
            <button
              key={name}
              className={page === name ? 'nav-item active' : 'nav-item'}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => setPage(name)}
            >
              <Icon name={name} />
              {name}
              <span>↗</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-seal">
            <Icon name="lock" />
            <strong>Access with purpose</strong>
            <p>Only records within your assigned scope are available.</p>
          </div>
          <span className="sidebar-caption">ACADEMIC RECORDS PLATFORM</span>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{page}</strong>
          </div>
          <div className="account">
            <span className="avatar">{session.principal.subject.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{session.principal.subject}</strong>
              <small>
                {[...new Set(session.principal.roles.map((r) => r.role))].join(' · ') ||
                  'No assigned role'}
              </small>
            </div>
            <button className="text-button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow dark">YOUR ACADEMIC WORKSPACE</div>
              <h1>
                {page === 'Overview'
                  ? 'Records with a history.'
                  : page === 'Records'
                    ? 'Academic records'
                    : page === 'Evidence'
                      ? 'Supporting evidence'
                      : 'Review & decisions'}
              </h1>
              <p>
                {page === 'Overview'
                  ? 'A considered view of the records you’re authorised to access.'
                  : page === 'Records'
                    ? 'Explore current results and how they appeared at an earlier point in time.'
                    : page === 'Evidence'
                      ? 'Submit and retrieve integrity-checked supporting information.'
                      : 'Track a correction from proposal to independent decision.'}
              </p>
            </div>
            <Badge tone="green">
              <span className="dot" /> Role-scoped access
            </Badge>
          </div>
          <div className="context-bar">
            <Field label="Student">
              <select
                value={student}
                disabled={!students.length}
                onChange={(e) => {
                  if (e.target.value === student) return;
                  transcriptRequest.current++;
                  setStudent(e.target.value);
                  setTranscript(null);
                }}
              >
                <option value="" disabled>
                  {loading ? 'Loading students…' : 'No students in scope'}
                </option>
                {students.map((s) => (
                  <option key={s.studentId} value={s.studentId}>
                    {s.studentCode}
                  </option>
                ))}
              </select>
            </Field>
            <div className="context-details">
              <span>SELECTED SUBJECT</span>
              <code>{student || 'No accessible student'}</code>
            </div>
          </div>
          {error && <Alert>{error}</Alert>}
          {page === 'Overview' && (
            <>
              <div className="metric-grid">
                <div className="metric">
                  <span>RESULTS IN THIS VIEW</span>
                  <strong>{loading ? '—' : records.length}</strong>
                  <small>Selected student and query time</small>
                </div>
                <div className="metric">
                  <span>COURSE CREDITS</span>
                  <strong>
                    {loading ? '—' : records.reduce((sum, r) => sum + Number(r.credits), 0)}
                  </strong>
                  <small>Across visible course results</small>
                </div>
                <div className="metric">
                  <span>VERSIONED RECORDS</span>
                  <strong>{loading ? '—' : records.filter((r) => r.version_no > 1).length}</strong>
                  <small>Results with a later recorded version</small>
                </div>
              </div>
              <div className="overview-grid">
                <Panel
                  title="Your records, at a glance"
                  subtitle="A snapshot from the selected transcript query."
                >
                  <RecordsTable records={records} loading={loading} />
                  <button className="panel-link" onClick={() => setPage('Records')}>
                    Explore all records <Icon name="arrow" />
                  </button>
                </Panel>
                <section className="guide-card">
                  <span className="eyebrow">A TRACEABLE PROCESS</span>
                  <h2>
                    Careful changes.
                    <br />
                    Lasting context.
                  </h2>
                  <ol>
                    <li>
                      <span>1</span>
                      <div>
                        <strong>Support a correction</strong>
                        <p>Attach evidence to the exact record.</p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>Request a review</strong>
                        <p>A registrar proposes the next revision.</p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>Keep decisions independent</strong>
                        <p>A different registrar approves or rejects.</p>
                      </div>
                    </li>
                  </ol>
                  <button onClick={() => setPage(canEvidence ? 'Evidence' : 'Review')}>
                    Open {canEvidence ? 'evidence' : 'review'} <Icon name="arrow" />
                  </button>
                </section>
              </div>
              <div className="scope-note">
                <Icon name="lock" />
                <p>
                  <strong>History stays available.</strong> A later recorded revision and the grade
                  effective today can differ. Use the Records time filters to explore both.
                </p>
              </div>
            </>
          )}
          {page === 'Records' && (
            <>
              <Panel
                title="Transcript time filters"
                subtitle="“Known at” chooses recorded history. “Effective at” chooses the academic date."
              >
                <form
                  className="filter-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void loadTranscript(
                      String(data.get('knownAt')),
                      String(data.get('effectiveAt')),
                    );
                  }}
                >
                  <Field label="Known at (local time)">
                    <input type="datetime-local" name="knownAt" />
                  </Field>
                  <Field label="Effective at (local time)">
                    <input type="datetime-local" name="effectiveAt" />
                  </Field>
                  <button className="primary" disabled={loading || !student}>
                    Apply time filters
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={loading || !student}
                    onClick={(event) => {
                      event.currentTarget.form?.reset();
                      void loadTranscript();
                    }}
                  >
                    Current view
                  </button>
                </form>
              </Panel>
              <Panel
                title="Course results"
                subtitle={
                  transcript
                    ? `Known: ${date(transcript.knownAt)} · Effective: ${date(transcript.effectiveAt)}`
                    : 'Select an accessible student.'
                }
              >
                <RecordsTable records={records} loading={loading} detailed />
              </Panel>
            </>
          )}
          {page === 'Evidence' && (
            <Evidence
              api={api}
              records={records}
              receipt={receipt}
              onReceipt={setReceipt}
              registrar={registrar}
              remember={remember}
            />
          )}
          {page === 'Review' && (
            <Review
              api={api}
              registrar={registrar}
              actor={session.principal.userId}
              recent={recent}
              activeRequest={activeRequest}
              remember={remember}
            />
          )}
          <footer className="workspace-footer">
            <span>Academic Records</span>
            <span>Privacy-Preserving Versioning and Verification of Academic Records</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
