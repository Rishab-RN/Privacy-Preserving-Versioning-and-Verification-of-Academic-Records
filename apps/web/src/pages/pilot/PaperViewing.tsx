import { useEffect, useRef, useState } from 'react';
import type {
  PilotDeskOffering,
  PilotPublication,
  PilotPublishedResult,
  PilotPvpProposal,
} from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message } from '../../api.js';
import { Alert, Empty, Field, Panel } from '../../ui.js';
import { loadPublication } from './Publication.js';
import { ResultsTable } from './ResultsTable.js';
import { newKey, OfferingPicker } from './shared.js';

/**
 * Registrars record an expert team's SEE theory revaluation after paper viewing. A different
 * registrar approves the resulting correction request on the Review page.
 */
export function PaperViewing({
  api,
  offerings,
  openRequest,
}: {
  api: Api;
  offerings: PilotDeskOffering[];
  openRequest: (requestId: string) => void;
}) {
  const [offeringId, setOfferingId] = useState(offerings[0]?.offeringId ?? '');
  const [publication, setPublication] = useState<PilotPublication | null | undefined>(undefined);
  const [row, setRow] = useState<PilotPublishedResult | null>(null);
  const [revised, setRevised] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<PilotPvpProposal | null>(null);
  const key = useRef<string | null>(null);

  async function load() {
    if (!offeringId) return;
    setPublication(undefined);
    try {
      setPublication(await loadPublication(api, offeringId));
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    setRow(null);
    setProposal(null);
    setError('');
    void load();
  }, [offeringId]);

  if (!offerings.length) {
    return (
      <Empty title="No published results">No published offering is open for correction.</Empty>
    );
  }

  function select(next: PilotPublishedResult) {
    setRow(next);
    setRevised({});
    setReason('');
    setProposal(null);
    setError('');
    key.current = null;
  }

  async function propose() {
    if (!row) return;
    const changes = Object.fromEntries(
      Object.entries(revised)
        .map(([code, value]) => [code, value.trim()])
        .filter(([, value]) => value !== ''),
    );
    key.current ??= newKey();
    setBusy(true);
    setError('');
    try {
      const result = await api<PilotPvpProposal>(
        `/pilot/records/${row.recordId}/pvp`,
        { expectedVersion: row.versionNo, revised: changes, reason: reason.trim() },
        key.current,
      );
      setProposal(result);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel
        title="Paper-viewing corrections"
        subtitle="Only SEE theory scripts can be revalued. The better of the two marks stands and no mark may go down."
      >
        <div className="pilot-toolbar">
          <OfferingPicker offerings={offerings} value={offeringId} onChange={setOfferingId} />
        </div>
        {publication === undefined && !error && <p role="status">Loading results…</p>}
        {publication === null && (
          <Empty title="Not published yet">Corrections start after provisional publication.</Empty>
        )}
        {publication?.final && (
          <p className="pilot-audit" role="status">
            Results are final; paper viewing is closed for this offering.
          </p>
        )}
        {publication && (
          <ResultsTable
            publication={publication}
            {...(publication.final ? {} : { action: { label: 'Revalue', onSelect: select } })}
          />
        )}
      </Panel>
      {row && (
        <Panel
          title={`Revaluation for ${row.studentCode}`}
          subtitle={`Current result: ${row.letter ?? row.status} (version ${row.versionNo}).`}
        >
          {error && <Alert>{error}</Alert>}
          {proposal ? (
            <div className="success" role="status">
              <strong>Correction request filed.</strong>
              <p>
                Raised {proposal.increased.join(', ')}; the recomputed grade is{' '}
                {proposal.result.letter ?? proposal.result.outcome}. Another registrar must approve
                request {proposal.request.requestId}.
              </p>
              <button className="secondary" onClick={() => openRequest(proposal.request.requestId)}>
                Open in Review
              </button>
            </div>
          ) : (
            <>
              <div className="form-grid">
                {row.paperViewing.map((component) => (
                  <Field
                    key={component.code}
                    label={`${component.code} (now ${component.marks} / ${Number(component.maximum)})`}
                    {...(component.marks === 'AB' ? { hint: 'Absent: no script to revisit.' } : {})}
                  >
                    <input
                      inputMode="decimal"
                      disabled={component.marks === 'AB' || busy}
                      value={revised[component.code] ?? ''}
                      onChange={(e) =>
                        setRevised((all) => ({ ...all, [component.code]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
              <Field label="Reason">
                <textarea
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="pilot-actions">
                <button
                  className="primary"
                  disabled={busy || !reason.trim() || !Object.values(revised).some((v) => v.trim())}
                  onClick={() => void propose()}
                >
                  File correction request
                </button>
              </div>
            </>
          )}
        </Panel>
      )}
    </>
  );
}
