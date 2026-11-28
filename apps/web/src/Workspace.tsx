import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import type { StudentSummary, TranscriptResponse, EvidenceReceipt } from '@scholarproof/contracts';
import type { Api, Page, Session } from './types.js';
import { Brand, Icon, Field, Alert, Panel } from './ui.js';
import { Dashboard, desks } from './pages/Dashboard.js';
import type { Desk } from './pages/Dashboard.js';
import { WorkspaceSwitch } from './WorkspaceSwitch.js';
import { date } from './format.js';
import { message } from './api.js';
import { RecordsTable } from './pages/RecordsTable.js';
import { RecordHistory } from './pages/RecordHistory.js';
import { Evidence } from './pages/Evidence.js';
import { Review } from './pages/Review.js';
import { Provenance } from './pages/Provenance.js';
import { CredentialStatus } from './pages/CredentialStatus.js';
import { PilotDesk } from './pages/pilot/PilotDesk.js';
const Zk = lazy(() => import('./pages/Zk.js').then((module) => ({ default: module.Zk })));
export function Workspace({
  session,
  api,
  logout,
}: {
  session: Session;
  api: Api;
  logout: () => Promise<void>;
}) {
  // Pilot staff without a records desk land on their pilot desks.
  const pilotOnly = session.principal.roles.every(({ role }) =>
    ['faculty', 'examiner', 'exam_staff', 'exam_approver', 'dean_academics'].includes(role),
  );
  const [page, setPage] = useState<Page>(
      pilotOnly && session.principal.roles.length > 0 ? 'Marks & results' : 'Overview',
    ),
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
  const hasStudentRole = session.principal.roles.some(({ role }) => role === 'student');
  const desk: Desk = registrar
    ? 'registrar'
    : canReview
      ? 'auditor'
      : hasStudentRole
        ? 'student'
        : 'reader';
  const institutions = [
    ...new Set(
      session.principal.roles
        .filter(({ role }) => role === 'registrar' || role === 'auditor')
        .map(({ institutionId }) => institutionId),
    ),
  ];
  const [graphTarget, setGraphTarget] = useState<{
    recordId: string;
    version: number;
    requestId: string;
    eventId: string | null;
  } | null>(null);
  const pages: Page[] = [
    'Overview',
    'Marks & results',
    'Records',
    ...(canEvidence ? ['Evidence' as const] : []),
    ...(canReview ? ['Review' as const, 'Provenance' as const] : []),
    ...(registrar ? ['Credential status' as const] : []),
    ...(hasStudentRole ? ['Private proofs' as const] : []),
  ];
  const transcriptRequest = useRef(0);
  const [history, setHistory] = useState<TranscriptResponse['records'][number] | null>(null);
  useEffect(() => {
    // Pilot-only staff have no student directory, so there is nothing to load.
    if (pilotOnly) {
      setLoading(false);
      return;
    }
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
  function navigate(destination: Page) {
    if (destination !== page && destination === 'Provenance') setGraphTarget(null);
    setPage(destination);
  }
  const screen: Partial<Record<Page, [string, string]>> = {
    'Marks & results': [
      'Marks and results',
      desk === 'student'
        ? 'Your published course results, with the CIE and SEE breakdown.'
        : 'Enter, review, validate, publish and correct course results within your duties.',
    ],
    Records: ['Academic records', 'Compare what was recorded with what took effect.'],
    Evidence: [
      'Supporting evidence',
      'Submit and retrieve integrity-checked supporting information.',
    ],
    Review: ['Review & decisions', 'Track corrections from proposal to independent decision.'],
    Provenance: ['Grade provenance', 'Inspect approval relationships and supporting evidence.'],
    'Private proofs': [
      'Private eligibility proofs',
      'Prove a grade threshold while keeping your exact result private.',
    ],
    'Credential status': [
      'Credential status',
      'Manage institutional proof credential revocations.',
    ],
  };
  const currentScreen = screen[page];
  const studentContext = (
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
            setHistory(null);
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
    </div>
  );
  return (
    <div className="workspace" data-desk={desk}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">{desks[desk].label}</div>
        <nav aria-label="Main navigation">
          {pages.map((name) => (
            <button
              key={name}
              className={page === name ? 'nav-item active' : 'nav-item'}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => navigate(name)}
            >
              <Icon name={name} />
              {name}
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <a className="sidebar-verifier" href="/verify">
            <Icon name="Private proofs" /> Public proof verifier <Icon name="arrow" />
          </a>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{page}</strong>
          </div>
          <WorkspaceSwitch pages={pages} navigate={navigate} />
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
          {currentScreen && (
            <div className="page-heading">
              <div>
                <p className="workspace-label">{desks[desk].label}</p>
                <h1>{currentScreen[0]}</h1>
                <p>{currentScreen[1]}</p>
              </div>
            </div>
          )}
          {(page === 'Records' || page === 'Evidence' || page === 'Private proofs') &&
            studentContext}
          {error && <Alert>{error}</Alert>}
          {page === 'Overview' && (
            <Dashboard
              desk={desk}
              transcript={transcript}
              loading={loading}
              directoryCount={students.length || (loading || error ? null : 0)}
              institutionCount={institutions.length}
              recent={recent}
              context={desk === 'student' || desk === 'reader' ? studentContext : null}
              navigate={navigate}
              openRequest={(id) => {
                remember(id);
                navigate('Review');
              }}
            />
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
                <RecordsTable records={records} loading={loading} detailed onHistory={setHistory} />
              </Panel>
              {history && (
                <RecordHistory
                  key={history.record_id}
                  api={api}
                  recordId={history.record_id}
                  course={history.course_code}
                />
              )}
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
          {page === 'Provenance' && (
            <Provenance
              api={api}
              institutions={institutions}
              initial={graphTarget}
              openRequest={(id) => {
                remember(id);
                navigate('Review');
              }}
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
              openProvenance={(recordId, version, requestId, eventId) => {
                setGraphTarget({ recordId, version, requestId, eventId });
                setPage('Provenance');
              }}
            />
          )}
          {page === 'Private proofs' && (
            <Suspense fallback={<p role="status">Loading private proof tools…</p>}>
              <Zk key={student} api={api} studentId={student} />
            </Suspense>
          )}
          {page === 'Credential status' && <CredentialStatus api={api} />}
          {page === 'Marks & results' && (
            <PilotDesk
              api={api}
              student={hasStudentRole}
              openRequest={(id) => {
                remember(id);
                navigate('Review');
              }}
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
