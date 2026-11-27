import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import type { PilotOffering, PilotRoster } from '@scholarproof/contracts';
import { decide, PILOT_WORLD } from '../../packages/access-matrix/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { openDataRuntime, readDataConfig } from '../../apps/api/src/data-runtime.js';
import { digestToken, newToken } from '../../apps/api/src/security.js';
import { connectTestClient, fixture } from '../database/helpers.js';

test('live pilot roster matches the published access matrix', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const academic = await fixture(admin);
  const outside = await fixture(admin);
  const { id } = academic;
  const departments = { AI: randomUUID(), IS: randomUUID() };
  const foreignDepartment = randomUUID();
  await admin.query(
    'INSERT INTO pilot.department VALUES ($1,$2,$3,$3),($4,$2,$5,$5),($6,$7,$3,$3)',
    [
      departments.AI,
      id('institution'),
      'AI',
      departments.IS,
      'IS',
      foreignDepartment,
      outside.id('institution'),
    ],
  );
  const offers = { 'ai-a': id('offering'), 'ai-b': randomUUID(), 'is-a': randomUUID() };
  for (const [key, offering] of Object.entries(offers)) {
    if (key !== 'ai-a')
      await admin.query(
        'INSERT INTO academic.course_offering(offering_id,course_id,term_id,scheme_id,section_code,credits) VALUES($1,$2,$3,$4,$5,4)',
        [offering, id('course'), id('term'), id('scheme'), key],
      );
    await admin.query('INSERT INTO pilot.offering_department VALUES($1,$2)', [
      offering,
      key.startsWith('ai') ? departments.AI : departments.IS,
    ]);
  }
  await admin.query('INSERT INTO pilot.offering_department VALUES($1,$2)', [
    outside.id('offering'),
    foreignDepartment,
  ]);
  await assert.rejects(
    admin.query('UPDATE pilot.offering_department SET department_id=$1 WHERE offering_id=$2', [
      foreignDepartment,
      offers['ai-a'],
    ]),
    { code: '23514' },
  );
  const actors = new Map(
    Object.keys(PILOT_WORLD.principals).map((key) => [
      key,
      { id: randomUUID(), token: newToken() },
    ]),
  );
  for (const [key, actor] of actors) {
    await admin.query('INSERT INTO academic.app_user(user_id,auth_subject) VALUES($1,$2)', [
      actor.id,
      'pilot-test:' + actor.id,
    ]);
    await admin.query(
      'INSERT INTO access_control.api_session(user_id,token_digest) VALUES($1,$2)',
      [actor.id, digestToken(actor.token)],
    );
    const principal = PILOT_WORLD.principals[key]!;
    for (const role of principal.roles)
      await admin.query(
        'INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,$3)',
        [id('institution'), actor.id, role],
      );
    for (const duty of principal.offeringDuties ?? []) {
      await admin.query('INSERT INTO pilot.offering_duty VALUES($1,$2,$3)', [
        offers[duty.offering as keyof typeof offers],
        actor.id,
        duty.duty,
      ]);
    }
    for (const duty of principal.departmentDuties ?? []) {
      await admin.query('INSERT INTO pilot.department_duty VALUES($1,$2,$3,$4)', [
        departments[duty.department as keyof typeof departments],
        id('term'),
        actor.id,
        duty.duty,
      ]);
    }
  }
  const shifted = (at: string) =>
    new Date(Date.now() + Date.parse(at) - Date.parse(PILOT_WORLD.now));
  for (const [key, principal] of Object.entries(PILOT_WORLD.principals)) {
    for (const grant of principal.delegations ?? []) {
      if (!grant.tasks.includes('reconcile_roster')) continue;
      for (const dept of grant.departments) {
        await admin.query(
          'INSERT INTO pilot.roster_delegation(department_id,term_id,grantor_id,grantee_id,valid_during) VALUES($1,$2,$3,$4,tstzrange($5,$6))',
          [
            departments[dept as keyof typeof departments],
            id('term'),
            actors.get(grant.grantor)!.id,
            actors.get(key)!.id,
            shifted(grant.validFrom),
            shifted(grant.validUntil),
          ],
        );
      }
    }
  }
  const teacher = actors.get('F1')!,
    delegate = actors.get('S1')!,
    approver = actors.get('P1')!;
  await admin.query(
    `INSERT INTO pilot.roster_delegation(department_id,term_id,grantor_id,grantee_id,valid_during)
     VALUES($1,$2,$3,$4,tstzrange(now()-interval '2 days',now()-interval '1 day'))`,
    [departments.IS, id('term'), approver.id, actors.get('S2')!.id],
  );
  const config = readDataConfig();
  assert.ok(config);
  const runtime = await openDataRuntime(config);
  t.after(() => runtime.close());
  const server = createApp(runtime.platform).listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  function get(path: string, token?: string) {
    return fetch(
      `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}/api/v1/pilot/offerings${path}`,
      token ? { headers: { authorization: 'Bearer ' + token } } : undefined,
    );
  }

  await t.test('all fixture persona and offering combinations agree with the oracle', async () => {
    for (const key of actors.keys()) {
      for (const [offering, identifier] of Object.entries(offers)) {
        const expected = decide(PILOT_WORLD, key, 'roster.read', offering).outcome;
        const response = await get(`/${identifier}/roster`, actors.get(key)!.token);
        assert.equal(response.status, expected.status, key + '/' + offering);
        if (expected.status === 200) {
          const data = (await response.json()) as PilotRoster;
          assert.equal(data.students.length, offering === 'ai-a' ? 1 : 0);
        }
      }
    }
  });
  await t.test('offerings, pagination and foreign-tenant access stay scoped', async () => {
    const list = await get('', teacher.token);
    assert.equal(list.status, 200);
    const data = (await list.json()) as { offerings: PilotOffering[] };
    assert.deepEqual(
      data.offerings.map(({ offeringId }) => offeringId),
      [offers['ai-a']],
    );
    const roster = await get(`/${offers['ai-a']}/roster`, teacher.token);
    assert.deepEqual(await roster.json(), {
      students: [{ studentCode: 'SYNTHETIC', enrolmentId: id('enrolment') }],
      nextAfter: null,
    });
    const empty = await get(`/${offers['ai-a']}/roster?after=${id('enrolment')}`, teacher.token);
    assert.deepEqual(await empty.json(), { students: [], nextAfter: null });
    assert.equal((await get(`/${offers['ai-a']}/roster?after=bad`, teacher.token)).status, 400);
    assert.equal((await get(`/${outside.id('offering')}/roster`, approver.token)).status, 404);
    assert.equal((await get(`/${offers['ai-a']}/roster`)).status, 401);
  });
  await t.test('session revocation and delegation authority are checked live', async () => {
    await admin.query(
      "DELETE FROM academic.role_assignment WHERE user_id=$1 AND role_code='exam_approver'",
      [approver.id],
    );
    assert.equal((await get(`/${offers['ai-a']}/roster`, delegate.token)).status, 403);
    await admin.query(
      'UPDATE access_control.api_session SET revoked_at=clock_timestamp() WHERE token_digest=$1',
      [digestToken(teacher.token)],
    );
    assert.equal((await get(`/${offers['ai-a']}/roster`, teacher.token)).status, 401);
    await assert.rejects(
      runtime.platform.repository.sql.query('SELECT * FROM pilot.offering_duty'),
      { code: '42501' },
    );
    await assert.rejects(
      runtime.platform.repository.sql.query('SELECT * FROM pilot.roster_scopes($1,now())', [
        teacher.id,
      ]),
      { code: '42501' },
    );
  });
});
