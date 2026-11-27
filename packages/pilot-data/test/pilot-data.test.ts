import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PILOT_WORLD } from '@academic-records/access-matrix';
import {
  RVCE_2022_GPA_S2,
  RVCE_2022_ITL_S1,
  calculateResult,
  summarizeTranscript,
} from '@academic-records/assessment';
import {
  AIML_SEMESTER_V,
  DEFAULT_OPTIONS,
  SCENARIOS,
  TERM,
  generatePilotData,
  seeded,
  summarizePilotData,
} from '../src/index.js';

const data = generatePilotData();
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('the default dataset is deterministic and pinned by its SHA-256 fingerprint', () => {
  assert.equal(JSON.stringify(generatePilotData()), JSON.stringify(data));
  // Update deliberately when the generator, scenarios or policies change.
  assert.equal(
    fingerprint(data),
    'b5325d5ebb24650afcc4785af7d489de90cd3a5debd157f54227270a39baec8c',
  );
});

test('another seed changes generated students but never the named scenarios', () => {
  const other = generatePilotData({ ...DEFAULT_OPTIONS, seed: 7 });
  assert.notEqual(fingerprint(other), fingerprint(data));
  for (const [index, scenario] of SCENARIOS.entries()) {
    assert.deepEqual(other.assessments[index]?.marks, data.assessments[index]?.marks, scenario.key);
  }
  assert.notDeepEqual(other.assessments.at(-1)?.marks, data.assessments.at(-1)?.marks);
});

test('every named scenario reaches its intended outcome', () => {
  for (const [index, scenario] of SCENARIOS.entries()) {
    const assessment = data.assessments[index];
    assert.equal(assessment?.scenario, scenario.key);
    assert.equal(assessment.offering, 'ai-a');
    assert.equal(assessment.result.status, scenario.expect.status, scenario.key);
    assert.equal(assessment.result.letter, scenario.expect.letter, scenario.key);
  }
  const rounding = data.assessments.find((a) => a.scenario === 'rounding-sensitive');
  assert.equal(rounding?.result.roundingSensitive, true);
  assert.deepEqual(summarizePilotData(data).byStatus, {
    graded: 24,
    'not-eligible': 2,
    'see-absent': 1,
    transitional: 1,
  });
});

test('the Paper Viewing candidate passes after the better-of revaluation', () => {
  assert.equal(data.paperViewing.length, 1);
  const [entry] = data.paperViewing;
  assert.equal(entry?.usn, 'SYN24AI003');
  assert.deepEqual(entry.resolution.increased, ['see_part_b']);
  assert.equal(entry.result.letter, 'B+');
  assert.equal(entry.result.total?.percent, '63.27');
});

test('every stored result recomputes exactly, and ineligible students have no SEE marks', () => {
  for (const assessment of data.assessments) {
    const { attendance, marks } = assessment;
    assert.deepEqual(calculateResult(RVCE_2022_ITL_S1, { attendance, marks }), assessment.result);
    if (assessment.result.status === 'not-eligible') {
      assert.ok(!Object.keys(marks).some((code) => code.startsWith('see_')), assessment.usn);
    }
  }
});

test('people, offerings and personas match the access matrix fixture', () => {
  const staffKeys = Object.entries(PILOT_WORLD.principals)
    .filter(([, principal]) => !principal.roles.includes('student'))
    .map(([key]) => key);
  assert.deepEqual(
    data.staff.map((member) => member.key),
    staffKeys,
  );
  for (const offering of data.offerings) {
    const expected = PILOT_WORLD.offerings[offering.key];
    assert.equal(offering.department, expected?.department);
    assert.equal(offering.published, expected?.published);
    assert.equal(offering.course, 'CD252IA');
    assert.equal(offering.students.length, DEFAULT_OPTIONS.sections[offering.key]);
  }
  for (const result of Object.values(PILOT_WORLD.results)) {
    const first = data.offerings.find((o) => o.key === result.offering)?.students[0];
    assert.equal(data.students.find((s) => s.usn === first)?.persona, result.student);
  }
  assert.equal(data.students.filter((student) => student.persona).length, 3);
});

test('identifiers are synthetic, unique and cannot collide with real USNs', () => {
  const usns = data.students.map((student) => student.usn);
  assert.equal(new Set(usns).size, usns.length);
  for (const usn of usns) assert.match(usn, /^SYN24(AI|IS)\d{3}$/);
  assert.ok(!usns.some((usn) => usn.startsWith('1RV')));
  const subjects = [...data.students, ...data.staff].map((person) => person.subject);
  assert.equal(new Set(subjects).size, subjects.length);
  assert.equal(data.meta.synthetic, true);
  assert.ok(!JSON.stringify(data).toLowerCase().includes('password'));
});

test('AIML transcripts reuse the CD252IA result and recompute their SGPA', () => {
  const aiStudents = data.students.filter((student) => student.programme === 'BE-AI');
  assert.equal(data.transcripts.length, aiStudents.length);
  for (const transcript of data.transcripts) {
    const assessment = data.assessments.find((a) => a.usn === transcript.usn);
    const cd = transcript.courses.find((course) => course.course === 'CD252IA');
    if (assessment?.result.status === 'see-absent') {
      assert.deepEqual(transcript.pending, ['CD252IA']);
      assert.equal(cd, undefined);
    } else {
      assert.equal(cd?.letter, assessment?.result.letter);
    }
    assert.deepEqual(
      summarizeTranscript(RVCE_2022_GPA_S2, [TERM.code], transcript.courses),
      transcript.summary,
    );
  }
  assert.equal(data.transcripts[0]?.summary.terms[0]?.sgpa.value, '8.35', 'ST1: 167 / 20');
  const credits = AIML_SEMESTER_V.reduce((sum, course) => sum + Number(course.credits), 0);
  assert.equal(credits, 20, 'Semester V scheme total (S1 p.7)');
});

test('the dataset scales for measurements', () => {
  const large = generatePilotData({ seed: 1, sections: { 'ai-a': 240, 'ai-b': 120, 'is-a': 60 } });
  assert.equal(large.students.length, 420);
  assert.equal(large.assessments.filter((a) => a.offering === 'ai-a').length, 240);
  assert.equal(large.students.at(-1)?.usn, 'SYN24IS060');
  assert.ok(large.students.some((student) => student.usn === 'SYN24AI360'));
});

test('options are validated', () => {
  const sections = DEFAULT_OPTIONS.sections;
  const bad = [
    { seed: -1, sections },
    { seed: 1.5, sections },
    { seed: 1, sections: { ...sections, 'ai-a': SCENARIOS.length - 1 } },
    { seed: 1, sections: { ...sections, 'is-a': 0 } },
    { seed: 1, sections: { ...sections, 'ai-b': 2.5 } },
    { seed: 1, sections: { ...sections, 'ai-a': 990, 'ai-b': 10 } },
  ];
  for (const options of bad) assert.throws(() => generatePilotData(options), RangeError);
});

test('the seeded generator is reproducible and uniform in [0, 1)', () => {
  const a = seeded(42);
  const b = seeded(42);
  const draws = Array.from({ length: 1000 }, () => a.next());
  assert.deepEqual(
    Array.from({ length: 1000 }, () => b.next()),
    draws,
  );
  assert.ok(draws.every((value) => value >= 0 && value < 1));
  const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
});
