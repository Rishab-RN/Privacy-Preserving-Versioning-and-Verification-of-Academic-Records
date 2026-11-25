import type { TranscriptResponse } from '@scholarproof/contracts';
import type { ReactNode } from 'react';
import type { Page } from '../types.js';
import { date } from '../format.js';
import { Icon, Panel } from '../ui.js';
import { RecordsTable } from './RecordsTable.js';

export type Desk = 'student' | 'registrar' | 'auditor' | 'reader';
export const desks = {
  student: {
    title: 'Your academic record',
    label: 'Student workspace',
    description: 'Explore course results across revisions and share a private eligibility proof.',
  },
  registrar: {
    title: 'Registrar desk',
    label: 'Registrar workspace',
    description: 'Prepare corrections, review independent decisions, and trace approved revisions.',
  },
  auditor: {
    title: 'Audit workspace',
    label: 'Auditor workspace',
    description: 'Inspect decisions, version ancestry and the evidence behind each approval.',
  },
  reader: {
    title: 'Academic workspace',
    label: 'Records access',
    description: 'Browse records within your assigned scope.',
  },
} satisfies Record<Desk, { title: string; label: string; description: string }>;

const registrarActions = [
  {
    page: 'Review',
    title: 'Review a request',
    detail: 'Inspect the decision, revision and delivery status.',
  },
  {
    page: 'Provenance',
    title: 'Trace an approval',
    detail: 'Follow the version through its actors and evidence.',
  },
  {
    page: 'Credential status',
    title: 'Manage credential status',
    detail: 'Revoke an institutional proof credential.',
  },
] as const;
const auditorActions = [
  {
    page: 'Review',
    title: 'Inspect a decision',
    detail: 'Look up the proposal and its recorded outcome.',
  },
  {
    page: 'Records',
    title: 'Compare transcript snapshots',
    detail: 'Explore what was known and effective on a date.',
  },
] as const;

export function Dashboard({
  desk,
  transcript,
  loading,
  directoryCount,
  institutionCount,
  recent,
  context,
  navigate,
  openRequest,
}: {
  desk: Desk;
  transcript: TranscriptResponse | null;
  loading: boolean;
  directoryCount: number | null;
  institutionCount: number;
  recent: string[];
  context: ReactNode;
  navigate: (page: Page) => void;
  openRequest: (requestId: string) => void;
}) {
  const records = transcript?.records ?? [];
  const learner = desk === 'student';
  const staff = desk === 'registrar' || desk === 'auditor';
  const description = desks[desk];
  const mainPage =
    desk === 'registrar' ? 'Evidence' : desk === 'auditor' ? 'Provenance' : 'Records';
  const number = learner
    ? transcript
      ? records.length
      : '—'
    : desk === 'auditor'
      ? institutionCount
      : (directoryCount ?? '—');
  const metricLabel = learner
    ? 'course results in this snapshot'
    : desk === 'auditor'
      ? institutionCount === 1
        ? 'institution in scope'
        : 'institutions in scope'
      : 'students in the directory';
  return (
    <>
      <section className={`desk-hero desk-${desk}`}>
        <div className="desk-copy">
          <p className="workspace-label">{description.label}</p>
          <h1>{description.title}</h1>
          <p>{description.description}</p>
          <div className="flex flex-wrap gap-3">
            <button className="desk-primary" onClick={() => navigate(mainPage)}>
              {desk === 'registrar'
                ? 'Prepare a correction'
                : desk === 'auditor'
                  ? 'Explore provenance'
                  : 'Open transcript'}
              <Icon name="arrow" />
            </button>
            {learner && (
              <button className="desk-secondary" onClick={() => navigate('Private proofs')}>
                Create a private proof
              </button>
            )}
          </div>
        </div>
        <div className="desk-index">
          <Icon
            name={desk === 'auditor' ? 'Provenance' : desk === 'registrar' ? 'Review' : 'Records'}
          />
          <div className="desk-number">{number}</div>
          <p>{metricLabel}</p>
          {learner && transcript && <small>Effective {date(transcript.effectiveAt)}</small>}
        </div>
      </section>
      {context}
      {staff ? (
        <>
          <div
            className={`desk-actions grid grid-cols-1 gap-3 ${desk === 'registrar' ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}
          >
            {(desk === 'registrar' ? registrarActions : auditorActions).map((item) => (
              <button key={item.page} className="desk-action" onClick={() => navigate(item.page)}>
                <span className="action-icon">
                  <Icon name={item.page} />
                </span>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
                <Icon name="arrow" />
              </button>
            ))}
          </div>
          <Panel title="Recent requests" subtitle="Requests opened or submitted in this session.">
            {recent.length ? (
              <div className="request-list">
                {recent.map((id) => (
                  <button key={id} className="request-row" onClick={() => openRequest(id)}>
                    <Icon name="Review" />
                    <code>{id}</code>
                    <Icon name="arrow" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="desk-empty">
                <Icon name="Review" />
                <span>No requests opened yet.</span>
              </div>
            )}
          </Panel>
        </>
      ) : (
        <Panel
          title="Course results"
          {...(transcript ? { subtitle: `Known at ${date(transcript.knownAt)}` } : {})}
        >
          <RecordsTable records={records} loading={loading} />
          <button className="panel-link" onClick={() => navigate('Records')}>
            Explore versions <Icon name="arrow" />
          </button>
        </Panel>
      )}
    </>
  );
}
