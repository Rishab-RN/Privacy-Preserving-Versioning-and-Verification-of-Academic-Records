import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PILOT_WORLD, decide } from '../../packages/access-matrix/src/index.js';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import { pilotId, provisionPilot } from '../../apps/api/scripts/pilot/provision.js';
import { digestToken, newToken } from '../../apps/api/src/security.js';
import { connectTestClient } from '../database/helpers.js';
import { testAccounts, testCredentials as tools } from './pilot-fixture.js';

test('pilot provisioning seeds the synthetic institution once and matches the access matrix', async (t) => {
  const admin = await connectTestClient();
  t.after(() => admin.end());
  const data = generatePilotData();
  const accounts = testAccounts(data);

  const first = await provisionPilot(admin, accounts, tools, data);
  assert.deepEqual(first.counts, {
    accounts: 42, // 14 staff personas and 28 students
    students: 28,
    enrolments: 28,
    offeringDuties: 4,
    departmentDuties: 4,
    rosterDelegations: 1,
    offeringPolicies: 3,
    validationDelegations: 3, // S1 for AI; S2 for AI and IS
  });
  const second = await provisionPilot(admin, accounts, tools, data);
  assert.deepEqual(second, first, 'a repeated run changes nothing');

  await assert.rejects(
    provisionPilot(
      admin,
      accounts.map((a, i) => (i === 0 ? { ...a, password: 'changed-password-000000000000' } : a)),
      tools,
      data,
    ),
    /differs; nothing was reset/,
  );
  await assert.rejects(provisionPilot(admin, accounts.slice(1), tools, data), /do not match/);

  const offeringKey = new Map(Object.entries(first.offerings).map(([key, id]) => [id, key]));
  const subjectFor = new Map(data.staff.map((member) => [member.key, member.subject]));
  for (const student of data.students.filter((s) => s.persona)) {
    subjectFor.set(student.persona!, student.subject);
  }

  for (const [key, subject] of subjectFor) {
    const token = newToken();
    await admin.query(
      'INSERT INTO access_control.api_session(user_id,token_digest) SELECT user_id,$2 FROM academic.app_user WHERE auth_subject=$1',
      [subject, digestToken(token)],
    );
    const expected = Object.keys(first.offerings)
      .filter(
        (offering) => decide(PILOT_WORLD, key, 'roster.read', offering).outcome.status === 200,
      )
      .sort();
    const denied = Object.keys(first.offerings).every(
      (offering) => decide(PILOT_WORLD, key, 'roster.read', offering).outcome.status === 403,
    );
    if (denied) {
      await assert.rejects(
        admin.query('SELECT * FROM pilot.roster_offerings($1)', [digestToken(token)]),
        {
          code: '42501',
        },
      );
      continue;
    }
    const seen = await admin.query<{ offering_id: string }>(
      'SELECT offering_id FROM pilot.roster_offerings($1)',
      [digestToken(token)],
    );
    assert.deepEqual(
      seen.rows.map((row) => offeringKey.get(row.offering_id)).sort(),
      expected,
      `${key} roster offerings`,
    );
  }

  const f1 = newToken();
  await admin.query('INSERT INTO access_control.api_session(user_id,token_digest) VALUES($1,$2)', [
    pilotId('user:pilot:f1'),
    digestToken(f1),
  ]);
  const roster = await admin.query<{ student_code: string }>(
    'SELECT student_code FROM pilot.read_roster($1,$2,NULL)',
    [digestToken(f1), first.offerings['ai-a']],
  );
  assert.deepEqual(
    roster.rows.map((row) => row.student_code).sort(),
    data.offerings.find((o) => o.key === 'ai-a')?.students,
  );
  await assert.rejects(
    admin.query('SELECT * FROM pilot.read_roster($1,$2,NULL)', [
      digestToken(f1),
      first.offerings['is-a'],
    ]),
    { code: 'P0002' },
  );
});
