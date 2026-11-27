import {
  ZERO,
  compare,
  display,
  exactText,
  fromHundredths,
  parseHundredths,
  ratio,
  roundHalfUpHundredths,
} from './decimal.js';
import type { Ratio } from './decimal.js';
import { AssessmentError } from './errors.js';
import { PROPOSAL_SOURCE } from './policy.js';
import type { Citation, SourceDocument } from './policy.js';

export interface GpaClass {
  readonly label: string;
  readonly minimumCgpa: string;
}

export type GpaCitationKey =
  'sgpa' | 'cgpa' | 'counted' | 'earned' | 'degree' | 'classes' | 'percent' | 'unconfirmed';

export interface GpaPolicy {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly status: 'pending-institutional-confirmation' | 'confirmed';
  readonly sources: Readonly<Record<string, SourceDocument>>;
  /** Letters that carry grade points, descending. The last, zero-point letter is the fail grade. */
  readonly gradePoints: readonly { readonly letter: string; readonly points: number }[];
  readonly failLetter: string;
  /** Excluded from SGPA and CGPA until converted (I, W, X). */
  readonly transitional: readonly string[];
  /** No grade points and no SEE: NE/NSAR/NSSR, or DX in the AY 2026-27 rules. */
  readonly notEligible: readonly string[];
  /** Letters whose effect on SGPA/CGPA the sources leave unclear; computing with them is refused. */
  readonly unconfirmed: readonly { readonly letter: string; readonly question: string }[];
  readonly degreeMinimumCgpa: string;
  /** Descending by minimum. Each applies only once every programme course has been passed. */
  readonly classes: readonly GpaClass[];
  readonly citations: Readonly<Record<GpaCitationKey, readonly Citation[]>>;
}

export interface GpaCourse {
  readonly course: string;
  readonly term: string;
  /** Decimal credits with at most two fractional digits; `0` only for non-credit courses. */
  readonly credits: string;
  readonly letter: string;
  /** Mandatory non-credit courses appear on the grade card but never in SGPA or CGPA. */
  readonly kind?: 'credit' | 'non-credit';
}

export interface GpaFigure {
  /** Two decimals, rounded half-up for display. `null` when no credits count. */
  readonly value: string | null;
  readonly exact: string | null;
  readonly credits: string;
}

export type ExclusionReason = 'transitional' | 'not-eligible' | 'non-credit';

export interface Exclusion {
  readonly course: string;
  readonly letter: string;
  readonly reason: ExclusionReason;
}

export interface TermResult {
  readonly term: string;
  readonly sgpa: GpaFigure;
  /** Cumulative through this term. */
  readonly cgpa: GpaFigure;
  readonly creditsRegistered: string;
  readonly creditsEarned: string;
  readonly excluded: readonly Exclusion[];
}

export interface TranscriptSummary {
  readonly policy: { readonly id: string; readonly version: number; readonly status: string };
  readonly terms: readonly TermResult[];
  readonly cgpa: GpaFigure;
  readonly creditsEarned: string;
  /** Two-decimal CGPA × 10, the handbooks' reference conversion. */
  readonly percentEquivalent: string | null;
  readonly standing: {
    readonly meetsDegreeMinimum: boolean | null;
    /** The class the CGPA supports. Valid only once every programme course is passed. */
    readonly classIfAllPassed: string | null;
    /** True when a two-decimal, half-up CGPA would change the class or degree minimum. */
    readonly roundingSensitive: boolean;
  };
  /** Courses, credit and non-credit, with no passing grade in any attempt so far. */
  readonly outstanding: readonly {
    readonly course: string;
    readonly letter: string;
    readonly term: string;
  }[];
}

const MAX_CREDITS = 3000n;

function invalid(policy: string, message: string): never {
  throw new AssessmentError('POLICY_INVALID', `${policy}: ${message}`);
}

function cgpaThreshold(policy: string, text: string, what: string): Ratio {
  const value = fromHundredths(parseHundredths(text, `${policy} ${what}`, 'POLICY_INVALID'));
  if (compare(value, fromHundredths(1000n)) > 0) invalid(policy, `${what} exceeds 10`);
  return value;
}

/** Validates a GPA policy before use and returns it unchanged. */
export function assertGpaPolicy(policy: GpaPolicy): GpaPolicy {
  const id = policy.id;
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(id)) invalid(id, 'id must be a lowercase slug');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) invalid(id, 'bad version');
  const letters = new Set<string>();
  const claim = (letter: string) => {
    if (!letter.trim() || letters.has(letter)) invalid(id, `letter ${letter} is empty or reused`);
    letters.add(letter);
  };
  let previous = Number.POSITIVE_INFINITY;
  for (const { letter, points } of policy.gradePoints) {
    claim(letter);
    if (!Number.isInteger(points) || points < 0 || points > 10 || points >= previous) {
      invalid(id, 'grade points must be distinct integers descending from at most 10');
    }
    previous = points;
  }
  const last = policy.gradePoints.at(-1);
  if (!last || last.letter !== policy.failLetter || last.points !== 0) {
    invalid(id, 'the fail letter must be the last, zero-point grade');
  }
  for (const letter of [...policy.transitional, ...policy.notEligible]) claim(letter);
  for (const { letter, question } of policy.unconfirmed) {
    claim(letter);
    if (!question.trim()) invalid(id, `unconfirmed letter ${letter} needs a question`);
  }
  const minimum = cgpaThreshold(id, policy.degreeMinimumCgpa, 'degree minimum');
  let lowest: Ratio | null = null;
  for (const entry of policy.classes) {
    if (!entry.label.trim()) invalid(id, 'class label is required');
    const value = cgpaThreshold(id, entry.minimumCgpa, entry.label);
    if (lowest && compare(value, lowest) >= 0) invalid(id, 'classes must strictly descend');
    lowest = value;
  }
  if (!lowest || compare(lowest, minimum) !== 0) {
    invalid(id, 'the lowest class must start at the degree minimum CGPA');
  }
  for (const citation of Object.values(policy.citations).flat()) {
    if (citation.source !== PROPOSAL_SOURCE && !policy.sources[citation.source]) {
      invalid(id, `citation references unknown source ${citation.source}`);
    }
  }
  return policy;
}

type Classified =
  | { readonly kind: 'graded'; readonly points: bigint }
  | { readonly kind: 'excluded'; readonly reason: ExclusionReason };

interface Entry {
  readonly course: GpaCourse;
  readonly termIndex: number;
  readonly credits: bigint;
  readonly classified: Classified;
  readonly passed: boolean;
}

function pointsFor(policy: GpaPolicy, letter: string): number | undefined {
  return policy.gradePoints.find((grade) => grade.letter === letter)?.points;
}

function classify(policy: GpaPolicy, course: GpaCourse): Classified {
  const unconfirmed = policy.unconfirmed.find(({ letter }) => letter === course.letter);
  if (unconfirmed) throw new AssessmentError('POLICY_UNCONFIRMED', unconfirmed.question);
  const points = pointsFor(policy, course.letter);
  const transitional = policy.transitional.includes(course.letter);
  const notEligible = policy.notEligible.includes(course.letter);
  if (points === undefined && !transitional && !notEligible) {
    throw new AssessmentError('UNKNOWN_GRADE', `${course.letter} is not a ${policy.id} grade`);
  }
  if (course.kind === 'non-credit') return { kind: 'excluded', reason: 'non-credit' };
  if (points !== undefined) return { kind: 'graded', points: BigInt(points) };
  return { kind: 'excluded', reason: transitional ? 'transitional' : 'not-eligible' };
}

function creditsOf(course: GpaCourse): bigint {
  const value = parseHundredths(course.credits, `${course.course} credits`, 'INVALID_CREDITS');
  if (course.kind === 'non-credit') {
    if (value !== 0n) {
      throw new AssessmentError('INVALID_CREDITS', `${course.course} is non-credit; use 0`);
    }
  } else if (value <= 0n || value > MAX_CREDITS) {
    throw new AssessmentError('INVALID_CREDITS', `${course.course} credits must be in (0, 30]`);
  }
  return value;
}

interface Average {
  readonly value: Ratio | null;
  readonly figure: GpaFigure;
}

function average(entries: readonly Entry[], include: (entry: Entry) => boolean): Average {
  let weighted = 0n;
  let counted = 0n;
  for (const entry of entries) {
    if (entry.classified.kind !== 'graded' || !include(entry)) continue;
    weighted += entry.credits * entry.classified.points;
    counted += entry.credits;
  }
  if (counted === 0n) {
    return { value: null, figure: { value: null, exact: null, credits: display(ZERO) } };
  }
  const value = ratio(weighted, counted);
  return {
    value,
    figure: {
      value: display(value),
      exact: exactText(value),
      credits: display(fromHundredths(counted)),
    },
  };
}

const sumCredits = (entries: readonly Entry[]) =>
  display(fromHundredths(entries.reduce((total, entry) => total + entry.credits, 0n)));

const byCourse = <T extends { readonly course: string }>(a: T, b: T) =>
  a.course < b.course ? -1 : a.course > b.course ? 1 : 0;

/** The handbooks multiply the reported two-decimal CGPA by 10: 7.714… → 7.71 → 77.10. */
function percentEquivalent(cgpa: Ratio): string {
  const reported = roundHalfUpHundredths(cgpa);
  return display(ratio(reported.num * 10n, reported.den));
}

function standing(policy: GpaPolicy, cgpa: Ratio | null): TranscriptSummary['standing'] {
  if (!cgpa) return { meetsDegreeMinimum: null, classIfAllPassed: null, roundingSensitive: false };
  const at = (text: string) => fromHundredths(parseHundredths(text, 'threshold'));
  const decide = (value: Ratio) => ({
    meets: compare(value, at(policy.degreeMinimumCgpa)) >= 0,
    label:
      policy.classes.find((entry) => compare(value, at(entry.minimumCgpa)) >= 0)?.label ?? null,
  });
  const exact = decide(cgpa);
  const rounded = decide(roundHalfUpHundredths(cgpa));
  return {
    meetsDegreeMinimum: exact.meets,
    classIfAllPassed: exact.label,
    roundingSensitive: exact.meets !== rounded.meets || exact.label !== rounded.label,
  };
}

/**
 * SGPA per term and cumulative CGPA, following the handbook formulas exactly.
 *
 * - SGPA counts every credit course of the term except transitional grades, so an F counts as
 *   zero points with its credits.
 * - CGPA counts every credit course so far except F grades, so a later pass replaces an earlier
 *   failure.
 * - Grades without points (transitional, not eligible) and non-credit courses never count.
 *
 * `terms` lists every term in chronological order. Results of a rejected semester must be
 * removed by the caller before summarizing.
 */
export function summarizeTranscript(
  policy: GpaPolicy,
  terms: readonly string[],
  courses: readonly GpaCourse[],
): TranscriptSummary {
  if (new Set(terms).size !== terms.length || terms.some((term) => !term.trim())) {
    throw new AssessmentError('INVALID_TERMS', 'terms must be distinct, non-empty labels');
  }
  const entries: Entry[] = courses.map((course) => {
    const termIndex = terms.indexOf(course.term);
    if (termIndex < 0) throw new AssessmentError('UNKNOWN_TERM', `${course.term} is not listed`);
    const credits = creditsOf(course);
    const classified = classify(policy, course);
    return {
      course,
      termIndex,
      credits,
      classified,
      passed: (pointsFor(policy, course.letter) ?? 0) > 0,
    };
  });

  const attempts = new Set<string>();
  const passes = new Set<string>();
  for (const { course, passed } of entries) {
    const attempt = `${course.term}\u0000${course.course}`;
    if (attempts.has(attempt)) {
      throw new AssessmentError(
        'DUPLICATE_ATTEMPT',
        `${course.course} appears twice in ${course.term}`,
      );
    }
    attempts.add(attempt);
    if (passed && passes.has(course.course)) {
      throw new AssessmentError(
        'DUPLICATE_PASS',
        `${course.course} has more than one passing grade`,
      );
    }
    if (passed) passes.add(course.course);
  }

  const notFailed = (entry: Entry) => entry.course.letter !== policy.failLetter;
  const results: TermResult[] = terms.map((term, index) => {
    const inTerm = entries.filter((entry) => entry.termIndex === index);
    const creditCourses = inTerm.filter((entry) => entry.course.kind !== 'non-credit');
    return {
      term,
      sgpa: average(inTerm, () => true).figure,
      cgpa: average(entries, (entry) => entry.termIndex <= index && notFailed(entry)).figure,
      creditsRegistered: sumCredits(creditCourses),
      creditsEarned: sumCredits(creditCourses.filter((entry) => entry.passed)),
      excluded: inTerm
        .flatMap(({ course, classified }) =>
          classified.kind === 'excluded'
            ? [{ course: course.course, letter: course.letter, reason: classified.reason }]
            : [],
        )
        .sort(byCourse),
    };
  });

  const cgpa = average(entries, notFailed);
  const latest = new Map<string, Entry>();
  for (const entry of [...entries].sort((a, b) => a.termIndex - b.termIndex)) {
    latest.set(entry.course.course, entry);
  }
  const earned = entries.filter((entry) => entry.course.kind !== 'non-credit' && entry.passed);
  return {
    policy: { id: policy.id, version: policy.version, status: policy.status },
    terms: results,
    cgpa: cgpa.figure,
    creditsEarned: sumCredits(earned),
    percentEquivalent: cgpa.value === null ? null : percentEquivalent(cgpa.value),
    standing: standing(policy, cgpa.value),
    outstanding: [...latest.values()]
      .filter((entry) => !passes.has(entry.course.course))
      .map(({ course }) => ({ course: course.course, letter: course.letter, term: course.term }))
      .sort(byCourse),
  };
}
