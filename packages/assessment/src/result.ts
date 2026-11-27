import {
  ZERO,
  add,
  compare,
  display,
  exactText,
  fromHundredths,
  parseHundredths,
  percentOf,
  ratio,
  roundHalfUpWhole,
} from './decimal.js';
import type { Ratio } from './decimal.js';
import { AssessmentError } from './errors.js';
import { KINDS } from './policy.js';
import type { AssessmentPolicy, ComponentSpec, GroupSpec, Kind, Part } from './policy.js';

/** Marks are decimal strings (`'17.5'`). SEE components may be `'AB'` when the policy allows. */
export const ABSENT = 'AB';

export interface AttendanceInput {
  /** Eligibility after any condonation, decided by the attendance process. */
  readonly eligible: boolean;
  /** Recorded percentage, needed only to evaluate the X grade. */
  readonly percent?: string;
}

export interface StudentAssessment {
  readonly attendance: AttendanceInput;
  readonly marks: Readonly<Record<string, string>>;
}

export interface Score {
  readonly marks: string;
  readonly maximum: string;
  readonly percent: string;
}

export type ReasonCode =
  | 'ATTENDANCE_NOT_SATISFIED'
  | 'CIE_THEORY_BELOW_MINIMUM'
  | 'CIE_LAB_BELOW_MINIMUM'
  | 'SEE_THEORY_BELOW_MINIMUM'
  | 'SEE_LAB_BELOW_MINIMUM'
  | 'AGGREGATE_BELOW_MINIMUM'
  | 'SEE_ABSENT'
  | 'X_GRADE_CRITERIA_MET';

export interface CieEvaluation {
  readonly policy: { readonly id: string; readonly version: number };
  readonly eligible: boolean;
  readonly reasons: readonly ReasonCode[];
  readonly theory: Score;
  readonly lab: Score;
  readonly total: Score;
  /** True when half-up whole-percent rounding would change eligibility. */
  readonly roundingSensitive: boolean;
}

export type ResultStatus = 'graded' | 'not-eligible' | 'see-absent' | 'transitional';

export interface CourseResult {
  readonly policy: { readonly id: string; readonly version: number; readonly status: string };
  readonly status: ResultStatus;
  readonly letter: string | null;
  readonly gradePoints: number | null;
  readonly outcome: 'passed' | 'failed' | null;
  readonly reasons: readonly ReasonCode[];
  readonly cie: { readonly theory: Score; readonly lab: Score; readonly total: Score };
  readonly see: { readonly theory: Score; readonly lab: Score } | null;
  readonly total: (Score & { readonly exactPercent: string }) | null;
  /**
   * True when evaluating every percentage after half-up rounding to a whole number would give a
   * different status, letter or outcome. Official rounding is unconfirmed, so such results need
   * a human check before publication.
   */
  readonly roundingSensitive: boolean;
}

interface Located {
  readonly group: GroupSpec;
  readonly component: ComponentSpec;
}

interface PartScore {
  readonly value: Ratio;
  readonly maximum: Ratio;
}

type Totals = Readonly<Record<Kind, PartScore>>;

const hundredths = (text: string) => fromHundredths(parseHundredths(text, 'policy value'));

function locate(policy: AssessmentPolicy): ReadonlyMap<string, Located> {
  const index = new Map<string, Located>();
  for (const group of policy.groups) {
    for (const component of group.components) index.set(component.code, { group, component });
  }
  return index;
}

/** Rejects unknown codes and malformed or out-of-range values before anything is computed. */
function checkEntries(policy: AssessmentPolicy, marks: Readonly<Record<string, string>>) {
  const index = locate(policy);
  for (const [code, value] of Object.entries(marks)) {
    const located = index.get(code);
    if (!located) {
      throw new AssessmentError('UNKNOWN_COMPONENT', `${code} is not part of ${policy.id}`);
    }
    if (value === ABSENT) {
      if (!policy.absence.parts.includes(located.group.part)) {
        throw new AssessmentError('ABSENCE_NOT_ALLOWED', `${code} cannot be recorded as absent`);
      }
      continue;
    }
    const entered = parseHundredths(value, code);
    if (entered > parseHundredths(located.component.maximum, code)) {
      throw new AssessmentError(
        'MARKS_ABOVE_MAXIMUM',
        `${code} exceeds its maximum of ${located.component.maximum}`,
      );
    }
    if (located.component.optional && located.group.selection.rule === 'unconfirmed') {
      throw new AssessmentError('POLICY_UNCONFIRMED', located.group.selection.question);
    }
  }
}

function hasPart(policy: AssessmentPolicy, marks: Readonly<Record<string, string>>, part: Part) {
  const index = locate(policy);
  return Object.keys(marks).some((code) => index.get(code)?.group.part === part);
}

/** Returns null when any required component of the part is recorded as absent. */
function partTotals(
  policy: AssessmentPolicy,
  marks: Readonly<Record<string, string>>,
  part: Part,
): Totals | null {
  const totals: Record<Kind, { value: Ratio; maximum: Ratio }> = {
    theory: { value: ZERO, maximum: ZERO },
    lab: { value: ZERO, maximum: ZERO },
  };
  let absent = false;
  for (const group of policy.groups.filter((candidate) => candidate.part === part)) {
    let raw = 0n;
    let rawMaximum = 0n;
    for (const component of group.components.filter((candidate) => !candidate.optional)) {
      const value = marks[component.code];
      if (value === undefined) {
        throw new AssessmentError('MISSING_COMPONENT', `${component.code} is required`);
      }
      rawMaximum += parseHundredths(component.maximum, component.code);
      if (value === ABSENT) absent = true;
      else raw += parseHundredths(value, component.code);
    }
    const weight = parseHundredths(group.weight, group.code);
    const reduced = ratio(raw * weight, rawMaximum * 100n);
    const total = totals[group.kind];
    total.value = add(total.value, reduced);
    total.maximum = add(total.maximum, fromHundredths(weight));
  }
  return absent ? null : totals;
}

function score(part: PartScore): Score {
  return {
    marks: display(part.value),
    maximum: display(part.maximum),
    percent: display(percentOf(part.value, part.maximum)),
  };
}

function combine(a: PartScore, b: PartScore): PartScore {
  return { value: add(a.value, b.value), maximum: add(a.maximum, b.maximum) };
}

type Lens = (percent: Ratio) => Ratio;
const exact: Lens = (percent) => percent;
const rounded: Lens = roundHalfUpWhole;

const below = (part: PartScore, minimum: string, lens: Lens) =>
  compare(lens(percentOf(part.value, part.maximum)), hundredths(minimum)) < 0;

function cieReasons(policy: AssessmentPolicy, input: StudentAssessment, cie: Totals, lens: Lens) {
  const reasons: ReasonCode[] = [];
  if (!input.attendance.eligible) reasons.push('ATTENDANCE_NOT_SATISFIED');
  if (below(cie.theory, policy.minimumPercent.cie.theory, lens)) {
    reasons.push('CIE_THEORY_BELOW_MINIMUM');
  }
  if (below(cie.lab, policy.minimumPercent.cie.lab, lens)) reasons.push('CIE_LAB_BELOW_MINIMUM');
  return reasons;
}

function attendancePercent(input: StudentAssessment): Ratio | null {
  if (input.attendance.percent === undefined) return null;
  const value = fromHundredths(
    parseHundredths(input.attendance.percent, 'attendance percent', 'INVALID_ATTENDANCE'),
  );
  if (compare(value, fromHundredths(10_000n)) > 0) {
    throw new AssessmentError('INVALID_ATTENDANCE', 'attendance percent exceeds 100');
  }
  return value;
}

function cieOnly(policy: AssessmentPolicy, input: StudentAssessment): Totals {
  checkEntries(policy, input.marks);
  attendancePercent(input);
  const cie = partTotals(policy, input.marks, 'cie');
  if (!cie) throw new AssessmentError('ABSENCE_NOT_ALLOWED', 'CIE cannot be recorded as absent');
  return cie;
}

/** CIE scores and SEE eligibility. SEE entries may be present and are validated, not used. */
export function evaluateCie(policy: AssessmentPolicy, input: StudentAssessment): CieEvaluation {
  const cie = cieOnly(policy, input);
  const reasons = cieReasons(policy, input, cie, exact);
  return {
    policy: { id: policy.id, version: policy.version },
    eligible: reasons.length === 0,
    reasons,
    theory: score(cie.theory),
    lab: score(cie.lab),
    total: score(combine(cie.theory, cie.lab)),
    roundingSensitive:
      (reasons.length === 0) !== (cieReasons(policy, input, cie, rounded).length === 0),
  };
}

interface Decision {
  readonly status: ResultStatus;
  readonly letter: string | null;
  readonly gradePoints: number | null;
  readonly outcome: 'passed' | 'failed' | null;
  readonly reasons: readonly ReasonCode[];
}

function decide(
  policy: AssessmentPolicy,
  input: StudentAssessment,
  cie: Totals,
  see: Totals,
  lens: Lens,
): Decision {
  const ineligible = cieReasons(policy, input, cie, lens);
  if (ineligible.length) {
    const letter = policy.eligibility.ineligibleLetter;
    return {
      status: 'not-eligible',
      letter,
      gradePoints: null,
      outcome: null,
      reasons: ineligible,
    };
  }
  const reasons: ReasonCode[] = [];
  if (below(see.theory, policy.minimumPercent.see.theory, lens)) {
    reasons.push('SEE_THEORY_BELOW_MINIMUM');
  }
  if (below(see.lab, policy.minimumPercent.see.lab, lens)) reasons.push('SEE_LAB_BELOW_MINIMUM');
  const cieTotal = combine(cie.theory, cie.lab);
  const total = combine(cieTotal, combine(see.theory, see.lab));
  if (below(total, policy.minimumPercent.aggregate, lens)) reasons.push('AGGREGATE_BELOW_MINIMUM');

  const bands = policy.grades.bands;
  if (reasons.length === 0) {
    const percent = lens(percentOf(total.value, total.maximum));
    const band = bands.find(
      (candidate) => compare(percent, hundredths(candidate.minimumPercent)) >= 0,
    );
    if (!band || band.points === 0)
      throw new Error('Policy bands disagree with the aggregate minimum');
    return {
      status: 'graded',
      letter: band.letter,
      gradePoints: band.points,
      outcome: 'passed',
      reasons,
    };
  }

  const attendance = attendancePercent(input);
  const x = policy.transitionalX;
  if (
    attendance &&
    compare(lens(attendance), hundredths(x.minimumAttendancePercent)) >= 0 &&
    !below(cieTotal, x.minimumCiePercent, lens)
  ) {
    return {
      status: 'transitional',
      letter: 'X',
      gradePoints: null,
      outcome: null,
      reasons: [...reasons, 'X_GRADE_CRITERIA_MET'],
    };
  }
  const fail = bands[bands.length - 1];
  if (!fail) throw new Error('Policy has no fail band');
  return {
    status: 'graded',
    letter: fail.letter,
    gradePoints: fail.points,
    outcome: 'failed',
    reasons,
  };
}

const sameDecision = (a: Decision, b: Decision) =>
  a.status === b.status && a.letter === b.letter && a.outcome === b.outcome;

/**
 * Evaluates one student's course result exactly. The output is a plain, deterministic object:
 * identical policy and input always produce identical JSON, so an auditor can recompute it.
 */
export function calculateResult(policy: AssessmentPolicy, input: StudentAssessment): CourseResult {
  const cie = cieOnly(policy, input);
  const meta = { id: policy.id, version: policy.version, status: policy.status };
  const cieScores = {
    theory: score(cie.theory),
    lab: score(cie.lab),
    total: score(combine(cie.theory, cie.lab)),
  };
  const ineligible = cieReasons(policy, input, cie, exact);
  if (ineligible.length) {
    if (hasPart(policy, input.marks, 'see')) {
      throw new AssessmentError(
        'INELIGIBLE_HAS_SEE_MARKS',
        'SEE marks were supplied for a student who is not eligible for SEE',
      );
    }
    return {
      policy: meta,
      status: 'not-eligible',
      letter: policy.eligibility.ineligibleLetter,
      gradePoints: null,
      outcome: null,
      reasons: ineligible,
      cie: cieScores,
      see: null,
      total: null,
      roundingSensitive: cieReasons(policy, input, cie, rounded).length === 0,
    };
  }

  const see = partTotals(policy, input.marks, 'see');
  if (!see) {
    return {
      policy: meta,
      status: 'see-absent',
      letter: null,
      gradePoints: null,
      outcome: null,
      reasons: ['SEE_ABSENT'],
      cie: cieScores,
      see: null,
      total: null,
      roundingSensitive: false,
    };
  }

  const decision = decide(policy, input, cie, see, exact);
  const total = KINDS.reduce<PartScore>(
    (sum, kind) => combine(sum, combine(cie[kind], see[kind])),
    { value: ZERO, maximum: ZERO },
  );
  return {
    policy: meta,
    ...decision,
    cie: cieScores,
    see: { theory: score(see.theory), lab: score(see.lab) },
    total: { ...score(total), exactPercent: exactText(percentOf(total.value, total.maximum)) },
    roundingSensitive: !sameDecision(decision, decide(policy, input, cie, see, rounded)),
  };
}
