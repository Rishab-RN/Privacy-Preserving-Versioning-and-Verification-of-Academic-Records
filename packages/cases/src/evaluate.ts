import { addMonths, day, formatDay } from './dates.js';
import { CaseError } from './errors.js';
import type { CasePolicy, CaseType, RouteStep } from './policy.js';

/** A course result in the shape of `@academic-records/assessment`'s `CourseResult`. */
export interface ExamStanding {
  readonly status: 'graded' | 'not-eligible' | 'see-absent' | 'transitional';
  readonly letter: string | null;
}

export interface CaseCourse {
  readonly course: string;
  readonly credits: string;
  readonly kind: 'theory' | 'integrated' | 'lab' | 'project' | 'mooc';
  readonly attendanceSatisfied: boolean;
  /** Absent until results are declared. An administratively granted I is `transitional`/`I`. */
  readonly standing?: ExamStanding;
}

export interface StudentContext {
  readonly usn: string;
  /** Programme semester, 1-8. */
  readonly semester: number;
  readonly term: string;
  readonly semesterKind: 'regular' | 'fast-track';
  /** Every course registered this term. */
  readonly courses: readonly CaseCourse[];
}

export interface DateWindow {
  readonly opens: string;
  readonly closes: string;
}

/** Term dates from the academic calendar and CoE circulars. Unannounced windows are omitted. */
export interface TermCalendar {
  readonly term: string;
  readonly semesterStart: string;
  readonly dropWindow?: DateWindow;
  readonly withdrawalDeadline?: string;
  readonly lastExamDay?: string;
  readonly provisionalResults?: string;
  readonly paperViewingRegistration?: DateWindow;
  readonly makeUpRegistration?: DateWindow;
}

export type IGradeReason = 'medical' | 'family-calamity' | 'institution-representation';

export type CaseRequest =
  | {
      readonly type: 'paper-viewing' | 'make-up' | 'drop' | 'withdrawal';
      readonly course: string;
      readonly submittedOn: string;
    }
  | {
      readonly type: 'i-grade';
      readonly course: string;
      /** When the supporting documents reach the CoE. */
      readonly submittedOn: string;
      readonly reason: IGradeReason;
      readonly examDate: string;
      readonly intimatedOn: string | null;
      readonly priorPermission?: boolean;
    };

export type CaseReason =
  | 'COURSE_NOT_REGISTERED'
  | 'FIRST_YEAR'
  | 'RESULT_DECLARED'
  | 'RESULT_NOT_AVAILABLE'
  | 'WINDOW_NOT_ANNOUNCED'
  | 'OUTSIDE_WINDOW'
  | 'BEFORE_PROVISIONAL_RESULTS'
  | 'LAB_EXCLUDED'
  | 'NOT_A_WRITTEN_SEE'
  | 'NO_EVALUATED_SCRIPT'
  | 'NOT_I_OR_X'
  | 'FAST_TRACK_EXCLUDED'
  | 'MOOC_EXCLUDED'
  | 'CREDITS_BELOW_MINIMUM'
  | 'ATTENDANCE_NOT_SATISFIED'
  | 'CIE_NOT_SATISFIED'
  | 'NOT_ABSENT_FROM_SEE'
  | 'NO_INTIMATION'
  | 'LATE_INTIMATION'
  | 'PRIOR_PERMISSION_MISSING'
  | 'EXAM_DATE_OUTSIDE_TERM'
  | 'DOCUMENTS_LATE';

export interface CaseDecision {
  readonly policy: { readonly id: string; readonly version: number };
  readonly type: CaseType;
  readonly course: string;
  readonly eligible: boolean;
  readonly reasons: readonly CaseReason[];
  /** The last day to act, when one applies and is known. */
  readonly deadline: string | null;
  readonly route: readonly RouteStep[];
  readonly effects: readonly string[];
}

function hundredths(text: string, what: string): number {
  const match = /^(0|[1-9]\d?)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new CaseError('INVALID_CREDITS', `${what} must be a decimal credit value`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

interface Window {
  readonly opens: number;
  readonly closes: number;
}

function toWindow(range: DateWindow | undefined, what: string): Window | undefined {
  if (!range) return undefined;
  const opens = day(range.opens, `${what} opening`, 'INVALID_CALENDAR');
  const closes = day(range.closes, `${what} closing`, 'INVALID_CALENDAR');
  if (opens > closes) throw new CaseError('INVALID_CALENDAR', `${what} closes before it opens`);
  return { opens, closes };
}

interface Calendar {
  readonly start: number;
  readonly drop?: Window;
  readonly withdrawal?: number;
  readonly lastExam?: number;
  readonly provisional?: number;
  readonly paperViewing?: Window;
  readonly makeUp?: Window;
}

function optionalDay(text: string | undefined, what: string) {
  return text === undefined ? undefined : day(text, what, 'INVALID_CALENDAR');
}

function readCalendar(policy: CasePolicy, calendar: TermCalendar): Calendar {
  const start = day(calendar.semesterStart, 'semester start', 'INVALID_CALENDAR');
  const parsed: Calendar = {
    start,
    ...withValue('drop', toWindow(calendar.dropWindow, 'drop window')),
    ...withValue('withdrawal', optionalDay(calendar.withdrawalDeadline, 'withdrawal deadline')),
    ...withValue('lastExam', optionalDay(calendar.lastExamDay, 'last examination day')),
    ...withValue('provisional', optionalDay(calendar.provisionalResults, 'provisional results')),
    ...withValue(
      'paperViewing',
      toWindow(calendar.paperViewingRegistration, 'paper viewing window'),
    ),
    ...withValue('makeUp', toWindow(calendar.makeUpRegistration, 'make-up window')),
  };
  if (parsed.drop && parsed.drop.opens < addMonths(start, policy.dropOpensAfterMonths)) {
    throw new CaseError(
      'INVALID_CALENDAR',
      `the drop window may open no earlier than ${policy.dropOpensAfterMonths} month(s) after the semester starts`,
    );
  }
  if (
    parsed.paperViewing &&
    (parsed.provisional === undefined || parsed.paperViewing.opens < parsed.provisional)
  ) {
    throw new CaseError(
      'INVALID_CALENDAR',
      'paper viewing registration opens only after provisional results',
    );
  }
  for (const [name, value] of Object.entries(parsed)) {
    const first = typeof value === 'number' ? value : (value as Window).opens;
    if (first < start)
      throw new CaseError('INVALID_CALENDAR', `${name} precedes the semester start`);
  }
  return parsed;
}

function withValue<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function readStudent(student: StudentContext, calendar: TermCalendar) {
  if (student.term !== calendar.term) {
    throw new CaseError(
      'TERM_MISMATCH',
      `${student.usn} is in ${student.term}, not ${calendar.term}`,
    );
  }
  if (!Number.isInteger(student.semester) || student.semester < 1 || student.semester > 8) {
    throw new CaseError('INVALID_STUDENT', 'semester must be a programme semester from 1 to 8');
  }
  const codes = new Set<string>();
  let credits = 0;
  for (const course of student.courses) {
    if (codes.has(course.course)) {
      throw new CaseError('INVALID_STUDENT', `${course.course} is registered twice`);
    }
    codes.add(course.course);
    credits += hundredths(course.credits, `${course.course} credits`);
  }
  return credits;
}

const within = (date: number, range: Window) => date >= range.opens && date <= range.closes;

/**
 * Decides whether a student may file a case and returns who acts on it next. All failing
 * conditions are reported together. Malformed input throws `CaseError`; ineligibility does not.
 */
export function evaluateCase(
  policy: CasePolicy,
  calendar: TermCalendar,
  student: StudentContext,
  request: CaseRequest,
): CaseDecision {
  const dates = readCalendar(policy, calendar);
  const registered = readStudent(student, calendar);
  const submitted = day(request.submittedOn, 'submission date');
  const reasons: CaseReason[] = [];
  let deadline: number | undefined;
  const course = student.courses.find((candidate) => candidate.course === request.course);

  const windowCheck = (range: Window | undefined) => {
    if (!range) reasons.push('WINDOW_NOT_ANNOUNCED');
    else {
      deadline = range.closes;
      if (!within(submitted, range)) reasons.push('OUTSIDE_WINDOW');
    }
  };
  const creditsCheck = (removed: string) => {
    const remaining = registered - hundredths(removed, 'course credits');
    if (remaining < hundredths(policy.minimumRegisteredCredits, 'minimum credits')) {
      reasons.push('CREDITS_BELOW_MINIMUM');
    }
  };

  if (!course) {
    reasons.push('COURSE_NOT_REGISTERED');
  } else {
    const standing = course.standing;
    switch (request.type) {
      case 'paper-viewing':
        if (course.kind === 'lab') reasons.push('LAB_EXCLUDED');
        if (course.kind === 'project' || course.kind === 'mooc') reasons.push('NOT_A_WRITTEN_SEE');
        if (!standing) reasons.push('RESULT_NOT_AVAILABLE');
        else if (!(
          standing.status === 'graded' ||
          (standing.status === 'transitional' && standing.letter === 'X')
        )) {
          reasons.push('NO_EVALUATED_SCRIPT');
        }
        if (dates.provisional === undefined || submitted < dates.provisional) {
          reasons.push('BEFORE_PROVISIONAL_RESULTS');
        }
        windowCheck(dates.paperViewing);
        break;
      case 'make-up':
        if (!standing) reasons.push('RESULT_NOT_AVAILABLE');
        else if (!standing.letter || !policy.makeUpLetters.includes(standing.letter))
          reasons.push('NOT_I_OR_X');
        if (student.semesterKind === 'fast-track') reasons.push('FAST_TRACK_EXCLUDED');
        if (course.kind === 'mooc') reasons.push('MOOC_EXCLUDED');
        windowCheck(dates.makeUp);
        break;
      case 'drop':
      case 'withdrawal':
        if (policy.firstYearSemesters.includes(student.semester)) reasons.push('FIRST_YEAR');
        if (standing) reasons.push('RESULT_DECLARED');
        if (request.type === 'drop') windowCheck(dates.drop);
        else {
          if (dates.withdrawal === undefined) reasons.push('WINDOW_NOT_ANNOUNCED');
          else {
            deadline = dates.withdrawal;
            if (submitted < dates.start || submitted > dates.withdrawal)
              reasons.push('OUTSIDE_WINDOW');
          }
          if (!course.attendanceSatisfied) reasons.push('ATTENDANCE_NOT_SATISFIED');
        }
        creditsCheck(course.credits);
        break;
      case 'i-grade': {
        if (dates.lastExam === undefined) {
          throw new CaseError(
            'INVALID_CALENDAR',
            'the last examination day is needed for I-grade requests',
          );
        }
        const exam = day(request.examDate, 'examination date');
        if (!course.attendanceSatisfied) reasons.push('ATTENDANCE_NOT_SATISFIED');
        else if (standing?.status === 'not-eligible') reasons.push('CIE_NOT_SATISFIED');
        if (standing && standing.status !== 'see-absent' && standing.status !== 'not-eligible') {
          reasons.push('NOT_ABSENT_FROM_SEE');
        }
        if (exam < dates.start || exam > dates.lastExam) reasons.push('EXAM_DATE_OUTSIDE_TERM');
        if (request.reason === 'institution-representation') {
          if (!request.priorPermission) reasons.push('PRIOR_PERMISSION_MISSING');
        } else if (request.intimatedOn === null) {
          reasons.push('NO_INTIMATION');
        } else if (day(request.intimatedOn, 'intimation date') > exam) {
          reasons.push('LATE_INTIMATION');
        }
        deadline = Math.min(exam + policy.documentDays, dates.lastExam);
        if (submitted > deadline) reasons.push('DOCUMENTS_LATE');
        break;
      }
    }
  }

  const rule = policy.rules[request.type];
  return {
    policy: { id: policy.id, version: policy.version },
    type: request.type,
    course: request.course,
    eligible: reasons.length === 0,
    reasons,
    deadline: deadline === undefined ? null : formatDay(deadline),
    route: rule.route,
    effects: rule.effects,
  };
}
