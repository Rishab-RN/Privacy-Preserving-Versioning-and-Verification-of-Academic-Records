import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssessmentError,
  PROPOSAL_SOURCE,
  RVCE_2022_ITL_S1 as S1,
  RVCE_ACY2026_ITL_S3 as S3,
  assertPolicy,
} from '../src/index.js';
import type { AssessmentPolicy, GroupSpec } from '../src/index.js';

const invalid = (policy: AssessmentPolicy) =>
  assert.throws(
    () => assertPolicy(policy),
    (error: unknown) => error instanceof AssessmentError && error.code === 'POLICY_INVALID',
  );

const firstGroup = S1.groups[0] as GroupSpec;
const withGroups = (groups: readonly GroupSpec[]): AssessmentPolicy => ({ ...S1, groups });

test('shipped policies are valid and cite only declared sources or PROP', () => {
  for (const policy of [S1, S3]) {
    assert.equal(assertPolicy(policy), policy);
    const sources = new Set([...Object.keys(policy.sources), PROPOSAL_SOURCE]);
    for (const group of policy.groups) assert.ok(sources.has(group.citation.source));
    assert.equal(policy.status, 'pending-institutional-confirmation');
    assert.deepEqual(policy.rounding, { mode: 'exact', confirmed: false });
  }
});

test('both rubrics total CIE 100 + 50 and SEE 100 + 50, as in the CD252IA scheme', () => {
  for (const policy of [S1, S3]) {
    const totals = new Map<string, number>();
    for (const group of policy.groups) {
      const key = `${group.part}.${group.kind}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(group.weight));
    }
    assert.deepEqual(Object.fromEntries(totals), {
      'cie.theory': 100,
      'cie.lab': 50,
      'see.theory': 100,
      'see.lab': 50,
    });
  }
});

test('structural mistakes are rejected', () => {
  invalid(withGroups([...S1.groups, firstGroup]));
  invalid(withGroups(S1.groups.filter((group) => group.code !== 'see.lab')));
  invalid(withGroups([{ ...firstGroup, weight: '0' }, ...S1.groups.slice(1)]));
  invalid(
    withGroups([
      {
        ...firstGroup,
        components: [
          ...firstGroup.components,
          { code: 'quiz3', label: 'Quiz III', maximum: '10', optional: true },
        ],
      },
      ...S1.groups.slice(1),
    ]),
  );
  invalid(
    withGroups([
      { ...firstGroup, citation: { source: 'S9', locator: 'p.1' } },
      ...S1.groups.slice(1),
    ]),
  );
  invalid({ ...S1, id: 'Not A Slug' });
});

test('grade bands must descend, end at a zero-point fail band and match the aggregate', () => {
  const bands = S1.grades.bands;
  const reversed = [...bands.slice(0, -1)].reverse().concat(bands.slice(-1));
  invalid({ ...S1, grades: { ...S1.grades, bands: reversed } });
  invalid({ ...S1, grades: { ...S1.grades, bands: bands.slice(0, -1) } });
  invalid({ ...S1, minimumPercent: { ...S1.minimumPercent, aggregate: '35' } });
  invalid({
    ...S1,
    grades: {
      ...S1.grades,
      bands: bands.map((band) => (band.letter === 'P' ? { ...band, letter: 'NE' } : band)),
    },
  });
});
