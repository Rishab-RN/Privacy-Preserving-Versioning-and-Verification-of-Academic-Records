import type { AttendanceInput, ResultStatus } from '@academic-records/assessment';

/**
 * Named AI-A students with fixed marks, so demos and tests always see every outcome. Marks use
 * the `rvce-2022-itl-s1` components. Comments show the hand-computed totals.
 */
export interface Scenario {
  readonly key: string;
  readonly description: string;
  readonly attendance: AttendanceInput;
  readonly marks: Readonly<Record<string, string>>;
  /** Ability used for the student's other Semester V courses. */
  readonly ability: number;
  readonly expect: { readonly status: ResultStatus; readonly letter: string | null };
  /** Expert revaluation after the Paper Viewing Process, if this student registered. */
  readonly paperViewing?: Readonly<Record<string, string>>;
}

const cie = (
  quizzes: [string, string],
  tests: [string, string],
  el: [string, string, string, string],
  lab: [string, string, string],
) => ({
  quiz1: quizzes[0],
  quiz2: quizzes[1],
  test1: tests[0],
  test2: tests[1],
  el_case_study: el[0],
  el_program: el[1],
  el_seminar: el[2],
  el_design: el[3],
  lab_conduct: lab[0],
  lab_test: lab[1],
  lab_innovation: lab[2],
});

const see = (theory: [string, string], lab: [string, string, string]) => ({
  see_part_a: theory[0],
  see_part_b: theory[1],
  see_lab_writeup: lab[0],
  see_lab_conduct: lab[1],
  see_lab_viva: lab[2],
});

export const SCENARIOS: readonly Scenario[] = [
  {
    // CIE 78.8 + 44; SEE 73.5 + 41 = 237.3 / 300 = 79.1% -> A (the T2 golden student).
    key: 'demo-student',
    description: 'Published pass used for the student login (ST1) and the private-proof demo',
    attendance: { eligible: true, percent: '91.5' },
    marks: {
      ...cie(['8', '9'], ['38', '41.5'], ['8', '7', '9', '6'], ['18', '9', '17']),
      ...see(['15', '58.5'], ['8', '17', '16']),
    },
    ability: 0.8,
    expect: { status: 'graded', letter: 'A' },
  },
  {
    // CIE 98.6 + 50; SEE 95 + 49 = 292.6 / 300 = 97.53% -> O.
    key: 'distinction',
    description: 'Top performer',
    attendance: { eligible: true, percent: '96' },
    marks: {
      ...cie(['10', '10'], ['50', '49'], ['10', '10', '10', '9'], ['20', '10', '20']),
      ...see(['19', '76'], ['10', '20', '19']),
    },
    ability: 0.95,
    expect: { status: 'graded', letter: 'O' },
  },
  {
    // SEE theory 14 + 20 = 34 < 35 -> F. PVP raises part B to 26: 189.8 / 300 = 63.27% -> B+.
    key: 'pvp-candidate',
    description: 'Fails SEE theory by one mark; a Paper Viewing revaluation lifts it to a pass',
    attendance: { eligible: true, percent: '89' },
    marks: {
      ...cie(['7', '8'], ['35', '37'], ['7', '8', '7', '8'], ['16', '8', '15']),
      ...see(['14', '20'], ['8', '15', '14']),
    },
    ability: 0.6,
    expect: { status: 'graded', letter: 'F' },
    paperViewing: { see_part_b: '26' },
  },
  {
    // CIE 96 + 49 = 145 / 150 = 96.67%, attendance 92%, SEE theory 30 < 35 -> X.
    key: 'x-grade',
    description:
      'Strong CIE and attendance but fails SEE theory: transitional X, eligible for make-up',
    attendance: { eligible: true, percent: '92' },
    marks: {
      ...cie(['10', '9'], ['48', '47'], ['10', '10', '9', '10'], ['20', '10', '19']),
      ...see(['8', '22'], ['9', '18', '15']),
    },
    ability: 0.85,
    expect: { status: 'transitional', letter: 'X' },
  },
  {
    key: 'see-absent',
    description: 'Absent from the SEE theory paper; the I-grade decision is administrative',
    attendance: { eligible: true, percent: '86' },
    marks: {
      ...cie(['7', '7'], ['30', '32'], ['7', '6', '7', '6'], ['15', '7', '14']),
      ...see(['AB', 'AB'], ['7', '15', '14']),
    },
    ability: 0.6,
    expect: { status: 'see-absent', letter: null },
  },
  {
    // 40 + 20 + 40 + 19.5 = 119.5 / 300 = 39.83% -> F, but 40% if rounded: needs human review.
    key: 'rounding-sensitive',
    description:
      'Fails the 40% aggregate by half a mark; the outcome depends on unconfirmed rounding',
    attendance: { eligible: true, percent: '88' },
    marks: {
      ...cie(['6', '6'], ['25', '25'], ['2', '2', '2', '2'], ['10', '5', '5']),
      ...see(['10', '30'], ['5', '8', '6.5']),
    },
    ability: 0.45,
    expect: { status: 'graded', letter: 'F' },
  },
  {
    key: 'attendance-shortage',
    description: 'Attendance below the condonable limit: NE, no SEE',
    attendance: { eligible: false, percent: '68.5' },
    marks: cie(['5', '6'], ['28', '30'], ['6', '5', '6', '5'], ['14', '6', '12']),
    ability: 0.55,
    expect: { status: 'not-eligible', letter: 'NE' },
  },
  {
    // CIE theory 7 + 33 * 0.4 + 12 = 32.2 < 40 -> NE.
    key: 'cie-shortfall',
    description: 'CIE theory below 40%: NE, no SEE',
    attendance: { eligible: true, percent: '87' },
    marks: cie(['3', '4'], ['15', '18'], ['3', '4', '2', '3'], ['14', '6', '12']),
    ability: 0.4,
    expect: { status: 'not-eligible', letter: 'NE' },
  },
];
