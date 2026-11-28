import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PilotDeskOffering, PilotEntryForm } from '@scholarproof/contracts';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import { connectTestClient } from '../database/helpers.js';
import { personaSubjects, provisionTestPilot, sessionFor, startPilotApi } from './pilot-fixture.js';

const data = generatePilotData();

test('pilot desks show each persona only the duties they hold', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const fixture = await provisionTestPilot(admin, data);
  const tokens = new Map<string, string>();
  for (const [key, subject] of personaSubjects(data)) {
    tokens.set(key, await sessionFor(admin, subject));
  }
  const { call } = await startPilotApi(t, tokens);
  const keyOf = new Map(Object.entries(fixture.offerings).map(([key, id]) => [id, key]));

  /** A persona's desk as offering key → the flags that do not depend on workflow state. */
  async function desk(persona: string) {
    const response = await call<{ offerings: PilotDeskOffering[] }>('GET', '/pilot/desk', persona);
    assert.equal(response.status, 200, persona);
    return Object.fromEntries(
      response.json.offerings.map((o) => [
        keyOf.get(o.offeringId) ?? o.offeringId,
        {
          entry: o.entryStages,
          reviews: o.reviews,
          validates: o.validates,
          results: o.readsResults,
          corrects: o.corrects,
        },
      ]),
    );
  }
  const flags = (entry: string[], reviews = false, validates = false, results = false) => ({
    entry,
    reviews,
    validates,
    results,
    corrects: false,
  });

  assert.deepEqual(await desk('F1'), { 'ai-a': flags(['cie'], false, false, true) });
  assert.deepEqual(await desk('E1'), { 'ai-a': flags(['see']) });
  assert.deepEqual(await desk('H1'), {
    'ai-a': flags([], true, false, true),
    'ai-b': flags(['cie'], true, false, true),
  });
  assert.deepEqual(await desk('S1'), {
    'ai-a': flags([], false, true),
    'ai-b': flags([], false, true),
  });
  const registrar = await desk('R1');
  assert.deepEqual(Object.keys(registrar).sort(), ['ai-a', 'ai-b', 'is-a']);
  assert.ok(Object.values(registrar).every((o) => o.corrects && o.results));
  const approver = (await call<{ offerings: PilotDeskOffering[] }>('GET', '/pilot/desk', 'P1')).json
    .offerings;
  assert.ok(approver.length === 3 && approver.every((o) => o.publishes));
  for (const persona of ['D1', 'ST1']) assert.deepEqual(await desk(persona), {}, persona);
  assert.equal((await call('GET', '/pilot/desk', null)).status, 401);

  const form = (persona: string, key: string, stage: string) =>
    call<PilotEntryForm>(
      'GET',
      `/pilot/offerings/${fixture.offerings[key as 'ai-a']}/entry-form/${stage}`,
      persona,
    );
  const cie = await form('F1', 'ai-a', 'cie');
  assert.equal(cie.status, 200);
  assert.deepEqual([cie.json.components.length, cie.json.absenceAllowed], [11, false]);
  const see = await form('E1', 'ai-a', 'see');
  assert.deepEqual(
    [see.json.components.map((c) => c.code), see.json.absenceAllowed],
    [['see_part_a', 'see_part_b', 'see_lab_writeup', 'see_lab_conduct', 'see_lab_viva'], true],
  );
  assert.equal((await form('F1', 'ai-a', 'see')).status, 404);
  assert.equal((await form('F1', 'is-a', 'cie')).status, 404);
  assert.equal((await form('ST1', 'ai-a', 'cie')).status, 403);
});
