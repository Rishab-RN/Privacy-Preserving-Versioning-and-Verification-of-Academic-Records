import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ACTIONS,
  ACTION_NAMES,
  DECISIONS,
  DELEGABLE,
  GRANTS,
  PILOT_WORLD,
  SEPARATIONS,
  decide,
  enumerateCases,
  resourcesFor,
} from '../src/index.js';
import { MATRIX_PATH, formattedMatrix } from '../scripts/matrix-file.js';

test('delegations can confer only validation and roster reading', () => {
  for (const grant of GRANTS.filter((candidate) => candidate.via.kind === 'delegation')) {
    assert.ok(DELEGABLE.includes(grant.action), `${grant.action} is not delegable`);
  }
  assert.ok(
    !DELEGABLE.some((action) =>
      ['batch.review', 'results.publish', 'batch.revise'].includes(action),
    ),
  );
});

test('Dean Academics and auditors hold read-only grants', () => {
  for (const grant of GRANTS) {
    if (grant.via.kind === 'role' && ['dean_academics', 'auditor'].includes(grant.via.role)) {
      assert.equal(ACTIONS[grant.action].mode, 'read', `${grant.via.role} ${grant.action}`);
    }
  }
});

test('memberships that need a scoped duty grant nothing by themselves', () => {
  for (const grant of GRANTS) {
    if (grant.via.kind === 'role') {
      assert.ok(!['faculty', 'examiner', 'exam_staff'].includes(grant.via.role), grant.action);
    }
  }
});

test('every decision action has a separation rule', () => {
  for (const action of DECISIONS) {
    assert.ok(
      SEPARATIONS.some((rule) => rule.action === action),
      action,
    );
    assert.equal(ACTIONS[action].mode, 'write');
  }
});

test('each scope is paired with the kind of authority that can satisfy it', () => {
  const allowed = {
    assigned: ['offering'],
    authored: ['offering'],
    department: ['department'],
    delegated: ['delegation'],
    own: ['role'],
    'own-published': ['role'],
    institution: ['role'],
  } as const;
  for (const grant of GRANTS) {
    assert.ok(
      (allowed[grant.scope] as readonly string[]).includes(grant.via.kind),
      `${grant.action} ${grant.scope} via ${grant.via.kind}`,
    );
    assert.ok(grant.basis.locator.trim(), `${grant.action} needs a basis`);
  }
});

test('every non-public action has a grant; the verifier needs none', () => {
  for (const action of ACTION_NAMES) {
    const granted = GRANTS.some((grant) => grant.action === action);
    assert.equal(granted, ACTIONS[action].resource !== 'public', action);
  }
});

test('the enumeration covers every principal, action and resource exactly once', () => {
  const cases = enumerateCases(PILOT_WORLD);
  const perPrincipal = ACTION_NAMES.reduce(
    (sum, action) => sum + resourcesFor(PILOT_WORLD, action).length,
    0,
  );
  assert.equal(cases.length, (Object.keys(PILOT_WORLD.principals).length + 1) * perPrincipal);
  const keys = new Set(cases.map((c) => `${c.principal}|${c.action}|${c.resource}`));
  assert.equal(keys.size, cases.length);
  assert.deepEqual(enumerateCases(PILOT_WORLD), cases, 'enumeration is deterministic');
});

test('every persona has an allowed and a denied case; anonymous only verifies', () => {
  const cases = enumerateCases(PILOT_WORLD);
  // S2 exists to show that an expired delegation leaves no authority at all.
  const withoutAuthority = new Set(['S2']);
  for (const principal of Object.keys(PILOT_WORLD.principals)) {
    const own = cases.filter((c) => c.principal === principal && c.action !== 'proof.verify');
    assert.equal(
      own.some((c) => c.expected.status === 200),
      !withoutAuthority.has(principal),
      `${principal} allowed cases`,
    );
    assert.ok(
      own.some((c) => c.expected.status !== 200),
      `${principal} has a denied case`,
    );
  }
  for (const c of cases.filter((candidate) => candidate.principal === null)) {
    assert.equal(c.expected.status, c.action === 'proof.verify' ? 200 : 401, c.action);
  }
});

test('allowed decisions name the grant that allowed them', () => {
  for (const c of enumerateCases(PILOT_WORLD).filter(
    (x) => x.expected.status === 200 && x.principal,
  )) {
    const decision = decide(PILOT_WORLD, c.principal, c.action, c.resource);
    if (ACTIONS[c.action].resource === 'public') continue;
    assert.equal(GRANTS[decision.grant ?? -1]?.action, c.action, `${c.principal} ${c.action}`);
  }
});

test('MATRIX.md matches the generated matrix', async () => {
  const committed = (await readFile(MATRIX_PATH, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(
    committed,
    await formattedMatrix(),
    'run npm run render --workspace @academic-records/access-matrix',
  );
});
