import { useEffect, useState } from 'react';
import type { PilotDeskOffering } from '@scholarproof/contracts';
import type { Api } from '../../types.js';
import { message } from '../../api.js';
import { Alert, Empty } from '../../ui.js';
import { DepartmentReview } from './DepartmentReview.js';
import { ExamOffice } from './ExamOffice.js';
import { MarksEntry } from './MarksEntry.js';
import { MyResults } from './MyResults.js';
import { PaperViewing } from './PaperViewing.js';
import { Publication, Results } from './Publication.js';
import './pilot.css';

type Tab =
  | 'Marks entry'
  | 'Department review'
  | 'Exam office'
  | 'Publication'
  | 'Results'
  | 'Paper viewing'
  | 'My results';

/**
 * The marks-to-results pilot. Each person sees only the desks their duties allow; the API
 * still checks every request.
 */
export function PilotDesk({
  api,
  student,
  openRequest,
}: {
  api: Api;
  student: boolean;
  openRequest: (requestId: string) => void;
}) {
  const [offerings, setOfferings] = useState<PilotDeskOffering[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null);

  async function load() {
    try {
      setOfferings((await api<{ offerings: PilotDeskOffering[] }>('/pilot/desk')).offerings);
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!offerings) return <p role="status">Loading your desks…</p>;

  const where = (test: (o: PilotDeskOffering) => boolean) => offerings.filter(test);
  const desks: [Tab, PilotDeskOffering[]][] = [
    ['Marks entry', where((o) => o.entryStages.length > 0)],
    ['Department review', where((o) => o.reviews)],
    ['Exam office', where((o) => o.validates)],
    ['Publication', where((o) => o.publishes)],
    ['Results', where((o) => o.readsResults)],
    ['Paper viewing', where((o) => o.corrects && o.published)],
  ];
  const tabs: Tab[] = [
    ...desks.filter(([, list]) => list.length > 0).map(([name]) => name),
    ...(student ? (['My results'] as const) : []),
  ];
  const active = tab && tabs.includes(tab) ? tab : tabs[0];
  const scoped = (name: Tab) => desks.find(([candidate]) => candidate === name)?.[1] ?? [];

  if (!active) {
    return (
      <Empty title="No pilot duties">
        Your account holds no marks, review, validation, publication or results duty in the pilot.
      </Empty>
    );
  }
  return (
    <>
      <div className="pilot-tabs" role="tablist" aria-label="Pilot desks">
        {tabs.map((name) => (
          <button
            key={name}
            role="tab"
            id={`pilot-tab-${name.toLowerCase().replaceAll(' ', '-')}`}
            aria-selected={name === active}
            aria-controls="pilot-panel"
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="pilot-panel"
        aria-labelledby={`pilot-tab-${active.toLowerCase().replaceAll(' ', '-')}`}
      >
        {active === 'Marks entry' && <MarksEntry api={api} offerings={scoped(active)} />}
        {active === 'Department review' && <DepartmentReview api={api} offerings={offerings} />}
        {active === 'Exam office' && <ExamOffice api={api} offerings={offerings} />}
        {active === 'Publication' && (
          <Publication api={api} offerings={scoped(active)} changed={() => void load()} />
        )}
        {active === 'Results' && <Results api={api} offerings={scoped(active)} />}
        {active === 'Paper viewing' && (
          <PaperViewing api={api} offerings={scoped(active)} openRequest={openRequest} />
        )}
        {active === 'My results' && <MyResults api={api} />}
      </div>
    </>
  );
}
