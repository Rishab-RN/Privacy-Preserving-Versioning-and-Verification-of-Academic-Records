import { PILOT_WORLD } from '@academic-records/access-matrix';
import type { Delegation, Role } from '@academic-records/access-matrix';
import {
  RVCE_2022_GPA_S2,
  RVCE_2022_ITL_S1,
  RVCE_GRADE_BANDS,
  calculateResult,
  evaluateCie,
  resolvePaperViewing,
  summarizeTranscript,
} from '@academic-records/assessment';
import type {
  AttendanceInput,
  CourseResult,
  GpaCourse,
  PaperViewingResolution,
  TranscriptSummary,
} from '@academic-records/assessment';
import {
  AIML_SEMESTER_V,
  DEPARTMENTS,
  FIRST_NAMES,
  INSTITUTION,
  PILOT_COURSE,
  PROGRAMMES,
  TERM,
} from './catalogue.js';
import { seeded } from './random.js';
import type { Random } from './random.js';
import { SCENARIOS } from './scenarios.js';

export const SECTION_KEYS = ['ai-a', 'ai-b', 'is-a'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface PilotOptions {
  readonly seed: number;
  /** Students per section. AI-A needs room for every named scenario. */
  readonly sections: Readonly<Record<SectionKey, number>>;
}

export const DEFAULT_OPTIONS: PilotOptions = {
  seed: 20261127,
  sections: { 'ai-a': 12, 'ai-b': 10, 'is-a': 6 },
};

export interface PilotStudent {
  readonly usn: string;
  readonly name: string;
  readonly programme: string;
  readonly offering: SectionKey;
  readonly admissionYear: number;
  /** Proposed login subject; passwords are never part of the dataset. */
  readonly subject: string;
  /** Access-matrix persona (ST1, ST2, ST3) for the first student of each section. */
  readonly persona: string | null;
}

export interface PilotStaff {
  readonly key: string;
  readonly subject: string;
  readonly displayName: string;
  readonly persona: string;
  readonly roles: readonly Role[];
  readonly offeringDuties: readonly { readonly offering: string; readonly duty: string }[];
  readonly departmentDuties: readonly {
    readonly department: string;
    readonly term: string;
    readonly duty: string;
  }[];
  readonly delegations: readonly Delegation[];
}

export interface PilotOffering {
  readonly key: SectionKey;
  readonly course: string;
  readonly section: string;
  readonly department: string;
  readonly term: string;
  readonly published: boolean;
  readonly students: readonly string[];
}

export interface PilotAssessment {
  readonly usn: string;
  readonly offering: SectionKey;
  readonly scenario: string | null;
  readonly attendance: AttendanceInput;
  readonly marks: Readonly<Record<string, string>>;
  readonly result: CourseResult;
}

export interface PilotPaperViewing {
  readonly usn: string;
  readonly revised: Readonly<Record<string, string>>;
  readonly resolution: PaperViewingResolution;
  readonly result: CourseResult;
}

export interface PilotTranscript {
  readonly usn: string;
  readonly courses: readonly GpaCourse[];
  /** Courses whose result awaits an administrative decision and is left out of the averages. */
  readonly pending: readonly string[];
  readonly summary: TranscriptSummary;
}

export interface PilotData {
  readonly meta: {
    readonly name: string;
    readonly version: 1;
    readonly synthetic: true;
    readonly notice: string;
    readonly seed: number;
    readonly sections: Readonly<Record<SectionKey, number>>;
    readonly policies: {
      readonly assessment: { readonly id: string; readonly version: number };
      readonly gpa: { readonly id: string; readonly version: number };
    };
    readonly accessWorld: string;
  };
  readonly institution: typeof INSTITUTION;
  readonly term: typeof TERM;
  readonly departments: typeof DEPARTMENTS;
  readonly programmes: typeof PROGRAMMES;
  readonly course: typeof PILOT_COURSE;
  readonly offerings: readonly PilotOffering[];
  readonly staff: readonly PilotStaff[];
  readonly students: readonly PilotStudent[];
  readonly assessments: readonly PilotAssessment[];
  readonly paperViewing: readonly PilotPaperViewing[];
  readonly transcripts: readonly PilotTranscript[];
}

const POLICY = RVCE_2022_ITL_S1;
const GPA = RVCE_2022_GPA_S2;
const STREAM = 0x9e3779b9;

function validate(options: PilotOptions) {
  seeded(options.seed);
  for (const key of SECTION_KEYS) {
    const count = options.sections[key];
    if (!Number.isInteger(count) || count < 1 || count > 999) {
      throw new RangeError(`${key} must have between 1 and 999 students`);
    }
  }
  if (options.sections['ai-a'] < SCENARIOS.length) {
    throw new RangeError(
      `ai-a needs at least ${SCENARIOS.length} students for the named scenarios`,
    );
  }
  if (options.sections['ai-a'] + options.sections['ai-b'] > 999) {
    throw new RangeError('AI sections share a three-digit USN sequence (at most 999 students)');
  }
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A mark near `ability` of the maximum, in half-mark steps. */
function componentMark(random: Random, maximum: string, ability: number): string {
  const halves = Math.round(clamp(ability + (random.next() - 0.5) * 0.24) * Number(maximum) * 2);
  return halves % 2 === 0 ? `${halves / 2}` : `${(halves - 1) / 2}.5`;
}

function partMarks(random: Random, part: 'cie' | 'see', ability: number) {
  const marks: Record<string, string> = {};
  for (const group of POLICY.groups.filter((candidate) => candidate.part === part)) {
    for (const component of group.components.filter((candidate) => !candidate.optional)) {
      marks[component.code] = componentMark(random, component.maximum, ability);
    }
  }
  return marks;
}

function letterFor(random: Random, ability: number): string {
  const percent = clamp(ability + (random.next() - 0.5) * 0.2) * 100;
  const band = RVCE_GRADE_BANDS.find((candidate) => percent >= Number(candidate.minimumPercent));
  return band?.letter ?? 'F';
}

function transcriptLetter(result: CourseResult): string | null {
  return result.status === 'see-absent' ? null : result.letter;
}

/**
 * Builds the synthetic pilot institution. Identical options always produce identical data, and
 * every assessment result is computed by `@academic-records/assessment`.
 */
export function generatePilotData(options: PilotOptions = DEFAULT_OPTIONS): PilotData {
  validate(options);
  const names = seeded(options.seed);
  const marksStream = seeded((options.seed + STREAM) >>> 0);
  const gradesStream = seeded((options.seed + 2 * STREAM) >>> 0);

  // The access matrix gives each section one student persona (ST1 in AI-A, ...).
  const personaFor = new Map<string, string>(
    Object.values(PILOT_WORLD.results).map((result) => [result.offering, result.student]),
  );

  const counters: Record<string, number> = {};
  const students: PilotStudent[] = [];
  const offerings: PilotOffering[] = [];
  const assessments: PilotAssessment[] = [];
  const paperViewing: PilotPaperViewing[] = [];
  const transcripts: PilotTranscript[] = [];

  for (const key of SECTION_KEYS) {
    const offering = PILOT_WORLD.offerings[key];
    if (!offering) throw new Error(`access matrix has no offering ${key}`);
    const programme = PROGRAMMES.find((candidate) => candidate.department === offering.department);
    if (!programme) throw new Error(`no programme for department ${offering.department}`);
    const usns: string[] = [];

    for (let index = 0; index < options.sections[key]; index += 1) {
      const sequence = (counters[offering.department] = (counters[offering.department] ?? 0) + 1);
      const usn = `SYN${TERM.admissionYear % 100}${offering.department}${String(sequence).padStart(3, '0')}`;
      const initial = String.fromCharCode(65 + Math.floor(names.next() * 26));
      usns.push(usn);
      students.push({
        usn,
        name: `${names.pick(FIRST_NAMES)} ${initial}.`,
        programme: programme.code,
        offering: key,
        admissionYear: TERM.admissionYear,
        subject: `pilot:${usn.toLowerCase()}`,
        persona: index === 0 ? (personaFor.get(key) ?? null) : null,
      });

      const scenario = key === 'ai-a' ? SCENARIOS[index] : undefined;
      const ability =
        scenario?.ability ??
        0.35 + 0.2 * (marksStream.next() + marksStream.next() + marksStream.next());
      let attendance: AttendanceInput;
      let marks: Record<string, string>;
      if (scenario) {
        attendance = scenario.attendance;
        marks = { ...scenario.marks };
      } else {
        attendance = { eligible: true, percent: String(80 + Math.floor(marksStream.next() * 20)) };
        marks = partMarks(marksStream, 'cie', ability);
        if (evaluateCie(POLICY, { attendance, marks }).eligible) {
          marks = { ...marks, ...partMarks(marksStream, 'see', Math.max(0, ability - 0.05)) };
        }
      }
      const result = calculateResult(POLICY, { attendance, marks });
      assessments.push({
        usn,
        offering: key,
        scenario: scenario?.key ?? null,
        attendance,
        marks,
        result,
      });

      if (scenario?.paperViewing) {
        const resolution = resolvePaperViewing(POLICY, marks, scenario.paperViewing);
        paperViewing.push({
          usn,
          revised: scenario.paperViewing,
          resolution,
          result: calculateResult(POLICY, { attendance, marks: resolution.marks }),
        });
      }

      if (offering.department === 'AI') {
        const courses: GpaCourse[] = [];
        const pending: string[] = [];
        for (const course of AIML_SEMESTER_V) {
          const letter =
            course.code === PILOT_COURSE.code
              ? transcriptLetter(result)
              : letterFor(gradesStream, ability);
          if (letter === null) pending.push(course.code);
          else
            courses.push({ course: course.code, term: TERM.code, credits: course.credits, letter });
        }
        transcripts.push({
          usn,
          courses,
          pending,
          summary: summarizeTranscript(GPA, [TERM.code], courses),
        });
      }
    }

    offerings.push({
      key,
      course: offering.course,
      section: key.slice(-1).toUpperCase(),
      department: offering.department,
      term: offering.term,
      published: offering.published,
      students: usns,
    });
  }

  const staff: PilotStaff[] = Object.entries(PILOT_WORLD.principals)
    .filter(([, principal]) => !principal.roles.includes('student'))
    .map(([key, principal]) => ({
      key,
      subject: `pilot:${key.toLowerCase()}`,
      displayName: `Synthetic ${key}`,
      persona: principal.persona,
      roles: principal.roles,
      offeringDuties: principal.offeringDuties ?? [],
      departmentDuties: principal.departmentDuties ?? [],
      delegations: principal.delegations ?? [],
    }));

  return {
    meta: {
      name: 'Academic Records synthetic pilot dataset',
      version: 1,
      synthetic: true,
      notice:
        'All people, USNs and marks are synthetic. USNs use the SYN prefix so they cannot match ' +
        'a real RVCE USN. Course codes, credits and assessment rules come from public RVCE sources.',
      seed: options.seed,
      sections: options.sections,
      policies: {
        assessment: { id: POLICY.id, version: POLICY.version },
        gpa: { id: GPA.id, version: GPA.version },
      },
      accessWorld: PILOT_WORLD.name,
    },
    institution: INSTITUTION,
    term: TERM,
    departments: DEPARTMENTS,
    programmes: PROGRAMMES,
    course: PILOT_COURSE,
    offerings,
    staff,
    students,
    assessments,
    paperViewing,
    transcripts,
  };
}

export interface PilotSummary {
  readonly students: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byLetter: Readonly<Record<string, number>>;
  readonly roundingSensitive: number;
}

/** Counts used by the export script and README. */
export function summarizePilotData(data: PilotData): PilotSummary {
  const count = (values: readonly string[]) =>
    Object.fromEntries(
      [...new Set(values)].sort().map((value) => [value, values.filter((v) => v === value).length]),
    );
  return {
    students: data.students.length,
    byStatus: count(data.assessments.map((a) => a.result.status)),
    byLetter: count(data.assessments.map((a) => a.result.letter ?? 'none')),
    roundingSensitive: data.assessments.filter((a) => a.result.roundingSensitive).length,
  };
}
