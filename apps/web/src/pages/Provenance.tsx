import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ProvenanceReview } from '@scholarproof/contracts';
import type { Api } from '../types.js';
import { message } from '../api.js';
import { date, idPattern } from '../format.js';
import { Alert, Badge, Field, Panel } from '../ui.js';

function ResultsTable({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: string[];
  rows: ReactNode[][];
}) {
  if (!rows.length) return <p>No matching approvals in this view.</p>;
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, ...values]) => (
            <tr key={String(id)}>
              {values.map((value, index) => (
                <td key={index}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const identifier = (value: string | null) => (value ? <code>{value}</code> : '—');
function requests(ids: string[]) {
  return (
    <details>
      <summary>Request IDs</summary>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Provenance({
  api,
  institutions,
  initial,
}: {
  api: Api;
  institutions: string[];
  initial: { recordId: string; version: number } | null;
}) {
  const [institution, setInstitution] = useState(institutions[0] ?? '');
  const [recordId, setRecordId] = useState(initial?.recordId ?? '');
  const [version, setVersion] = useState(initial ? String(initial.version) : '');
  const [result, setResult] = useState<ProvenanceReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    setError('');
    setBusy(true);
    try {
      const params = recordId ? '?' + new URLSearchParams({ recordId, version }) : '';
      setResult(await api<ProvenanceReview>(`/provenance/${institution}${params}`));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Panel
        title="Look up provenance"
        subtitle="Review approval paths and patterns from the last 30 days."
      >
        <form className="filter-form" onSubmit={(event) => void load(event)}>
          <Field label="Institution">
            <select
              value={institution}
              required
              disabled={busy}
              onChange={(event) => {
                setInstitution(event.target.value);
                setResult(null);
              }}
            >
              {institutions.map((id) => (
                <option value={id} key={id}>
                  {id}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Grade record ID"
            hint="Optional. Enter the record ID and version to trace a revision."
          >
            <input
              value={recordId}
              pattern={idPattern}
              required={!!version}
              disabled={busy}
              onChange={(event) => {
                setRecordId(event.target.value);
                setResult(null);
              }}
            />
          </Field>
          <Field label="Grade version">
            <input
              type="number"
              min="1"
              max="2147483647"
              step="1"
              value={version}
              required={!!recordId}
              disabled={busy}
              onChange={(event) => {
                setVersion(event.target.value);
                setResult(null);
              }}
            />
          </Field>
          <button className="primary" disabled={busy || !institution}>
            {busy ? 'Loading provenance…' : 'Load provenance'}
          </button>
        </form>
      </Panel>
      {error && <Alert>{error}</Alert>}
      {result && (
        <>
          <Panel title="Projection freshness">
            <p role="status">
              <Badge tone={result.status === 'current' ? 'green' : 'amber'}>
                {result.status === 'current' ? 'Caught up' : 'Graph catching up'}
              </Badge>{' '}
              Processed {result.through} of {result.committed} committed log positions.
              {result.syncedAt && <> Last sync {date(result.syncedAt)}.</>}
            </p>
            {result.status === 'lagging' && (
              <p>Results are partial until the graph catches up. Refresh to check progress.</p>
            )}
          </Panel>
          {recordId && (
            <Panel
              title="Version ancestry"
              subtitle="Up to 21 versions, starting with the version requested."
            >
              <ResultsTable
                label="Version ancestry"
                columns={['Version', 'Request and date', 'Proposer', 'Approver', 'Evidence']}
                rows={result.ancestry.map((row) => [
                  row.version,
                  `v${row.version}`,
                  row.requestId ? (
                    <>
                      {identifier(row.requestId)}
                      {row.occurredAt && <p>{date(row.occurredAt)}</p>}
                    </>
                  ) : (
                    'Earlier version with unknown workflow provenance'
                  ),
                  identifier(row.proposerId),
                  identifier(row.approverId),
                  identifier(row.evidenceId),
                ])}
              />
            </Panel>
          )}
          <Panel
            title="Review signals"
            subtitle={`${date(result.from)} to ${date(result.to)}. Review patterns alongside the supporting requests.`}
          >
            <h3>Repeated proposer and approver pairs</h3>
            <ResultsTable
              label="Repeated proposer and approver pairs"
              columns={['Proposer', 'Approver', 'Approvals', 'Supporting requests']}
              rows={result.pairings.map((row) => [
                row.proposerId + row.approverId,
                identifier(row.proposerId),
                identifier(row.approverId),
                row.count,
                requests(row.requestIds),
              ])}
            />
            <h3>Upward corrections by course</h3>
            <ResultsTable
              label="Upward corrections by course"
              columns={['Course', 'Upward corrections', 'Total increase', 'Supporting requests']}
              rows={result.upward.map((row) => [
                row.courseId,
                identifier(row.courseId),
                row.count,
                (row.deltaHundredths / 100).toFixed(2),
                requests(row.requestIds),
              ])}
            />
            <h3>Evidence reuse</h3>
            <ResultsTable
              label="Evidence reuse"
              columns={['Evidence digest', 'Approvals', 'Supporting requests']}
              rows={result.evidenceReuse.map((row) => [
                row.digest,
                identifier(row.digest),
                row.count,
                requests(row.requestIds),
              ])}
            />
          </Panel>
        </>
      )}
    </>
  );
}
