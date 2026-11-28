import type { Router } from 'express';
import {
  ABSENT,
  AssessmentError,
  calculateResult,
  evaluateCie,
  getPolicy,
} from '@academic-records/assessment';
import type { AssessmentPolicy, CourseResult } from '@academic-records/assessment';
import type {
  PilotBatchStage,
  PilotCourseResult,
  PilotPublication,
  PilotPublishedResult,
  PilotPublishResult,
  PilotStudentResult,
} from '@scholarproof/contracts';
import { z } from 'zod';
import { batchFailure } from './assessment-batches.js';
import { ApiFailure } from './errors.js';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';

const publishInput = z
  .object({
    attendance: z
      .array(
        z
          .object({
            enrolmentId: uuid,
            eligible: z.boolean(),
            percent: z
              .string()
              .regex(/^\d{1,3}(\.\d{1,2})?$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(999),
  })
  .strict();
const noQuery = z.object({}).strict();

/** Stored marks keyed by component; `null` records an absence. */
export type StoredMarks = Readonly<Record<string, number | string | null>>;
export interface StoredAttendance {
  readonly eligible: boolean;
  readonly percent: number | string | null;
}
export type Outcome = PilotCourseResult['outcome'];

export const invalid = (code: string, message: string) => new ApiFailure(422, code, message);
const decimal = (value: number | string) => Number(value).toFixed(2);

export function loadPolicy(id: string, version: number): AssessmentPolicy {
  let policy: AssessmentPolicy;
  try {
    policy = getPolicy(id);
  } catch {
    throw new ApiFailure(409, 'POLICY_UNAVAILABLE', 'The offering policy is not installed');
  }
  if (policy.version !== version) {
    throw new ApiFailure(409, 'POLICY_UNAVAILABLE', 'The offering policy version is not installed');
  }
  return policy;
}

export function calculatorInput(marks: StoredMarks, attendance: StoredAttendance) {
  return {
    attendance: {
      eligible: attendance.eligible,
      ...(attendance.percent === null ? {} : { percent: decimal(attendance.percent) }),
    },
    marks: Object.fromEntries(
      Object.entries(marks).map(([code, points]) => [
        code,
        points === null ? ABSENT : decimal(points),
      ]),
    ),
  };
}

/** The stored form of a result. Results without grade points (NE, X, SEE absent) are incomplete. */
export function storedForm(result: CourseResult): { gradePoints: number | null; outcome: Outcome } {
  return result.gradePoints === null || result.outcome === null
    ? { gradePoints: null, outcome: 'incomplete' }
    : { gradePoints: result.gradePoints, outcome: result.outcome };
}

export function present(
  result: CourseResult,
  gradePoints: number | null,
  outcome: Outcome,
): PilotCourseResult {
  return {
    status: result.status,
    letter: result.letter,
    gradePoints,
    outcome,
    reasons: [...result.reasons],
    cie: result.cie,
    see: result.see,
    total: result.total
      ? { marks: result.total.marks, maximum: result.total.maximum, percent: result.total.percent }
      : null,
  };
}

const points = (value: number | string | null) => (value === null ? null : Number(value));

interface StoredGrade {
  readonly versionNo: number;
  readonly gradePoints: number | string | null;
  readonly outcome: Outcome;
}

/** Whether a recomputed result reproduces a stored grade version. */
function reproduces(
  result: CourseResult,
  stored: { gradePoints: number | null; outcome: Outcome },
): boolean {
  const expected = storedForm(result);
  return expected.gradePoints === stored.gradePoints && expected.outcome === stored.outcome;
}

export function installPublicationRoutes(router: Router, platform: Platform) {
  const sql = () => platform.repository.sql;

  router.post('/pilot/offerings/:offeringId/publish', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const offeringId = parse(uuid, request.params.offeringId);
    const input = parse(publishInput, request.body);
    const context = (
      await sql()
        .query<{
          cie_batch: string;
          see_batch: string;
          policy_id: string;
          policy_version: number;
          roster: { enrolmentId: string; studentCode: string }[];
          marks: { enrolmentId: string; component: string; points: number | null }[];
        }>('SELECT * FROM assessment.publication_inputs($1,$2)', [digest, offeringId])
        .catch(batchFailure)
    ).rows[0];
    if (!context) {
      throw new ApiFailure(409, 'POLICY_UNAVAILABLE', 'The offering has no assessment policy');
    }
    const policy = loadPolicy(context.policy_id, context.policy_version);
    const roster = new Map(context.roster.map((row) => [row.enrolmentId, row.studentCode]));
    const attendance = new Map<string, (typeof input.attendance)[number]>();
    for (const row of input.attendance) {
      if (attendance.has(row.enrolmentId)) {
        throw invalid('DUPLICATE_ENROLMENT', `${row.enrolmentId} appears more than once`);
      }
      if (!roster.has(row.enrolmentId)) {
        throw invalid('UNKNOWN_ENROLMENT', `${row.enrolmentId} is not enrolled in this offering`);
      }
      attendance.set(row.enrolmentId, row);
    }
    if (attendance.size !== roster.size) {
      throw invalid('ATTENDANCE_INCOMPLETE', 'Attendance must cover every enrolled student');
    }
    const marks = new Map<string, Record<string, number | null>>();
    for (const mark of context.marks) {
      const row = marks.get(mark.enrolmentId) ?? {};
      row[mark.component] = mark.points;
      marks.set(mark.enrolmentId, row);
    }
    const seeCodes = new Set(
      policy.groups
        .filter((group) => group.part === 'see')
        .flatMap((group) => group.components.map((component) => component.code)),
    );
    const results = [...roster].map(([enrolmentId, studentCode]) => {
      const row = attendance.get(enrolmentId)!;
      const assessment = calculatorInput(marks.get(enrolmentId) ?? {}, {
        eligible: row.eligible,
        percent: row.percent ?? null,
      });
      try {
        const hasSee = Object.keys(assessment.marks).some((code) => seeCodes.has(code));
        if (!hasSee && evaluateCie(policy, assessment).eligible) {
          throw invalid(
            'SEE_ROWS_MISSING',
            `${studentCode} is eligible for SEE but has no SEE row`,
          );
        }
        return { enrolmentId, ...storedForm(calculateResult(policy, assessment)) };
      } catch (error) {
        if (error instanceof AssessmentError) {
          throw invalid(error.code, `${studentCode}: ${error.message}`);
        }
        throw error;
      }
    });
    const published = (
      await sql()
        .query<{ publication_id: string; published_at: string; created: boolean }>(
          'SELECT * FROM assessment.publish_results($1,$2,$3,$4,$5,$6)',
          [
            digest,
            offeringId,
            context.cie_batch,
            context.see_batch,
            JSON.stringify(
              input.attendance.map((row) => ({
                enrolmentId: row.enrolmentId,
                eligible: row.eligible,
                percent: row.percent ?? null,
              })),
            ),
            JSON.stringify(results),
          ],
        )
        .catch(batchFailure)
    ).rows[0]!;
    const result: PilotPublishResult = {
      publicationId: published.publication_id,
      offeringId,
      kind: 'provisional',
      publishedAt: published.published_at,
      records: results.length,
      inputs: { cie: context.cie_batch, see: context.see_batch },
      alreadyPublished: !published.created,
    };
    response.status(published.created ? 201 : 200).json(result);
  });

  router.get('/pilot/offerings/:offeringId/publication', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const offeringId = parse(uuid, request.params.offeringId);
    parse(noQuery, request.query);
    const row = (
      await sql()
        .query<{
          publication_id: string;
          kind: 'provisional' | 'final';
          publisher_subject: string;
          published_at: string;
          policy_id: string;
          policy_version: number;
          inputs: { batchId: string; stage: PilotBatchStage; revisionNo: number }[];
          results: {
            enrolmentId: string;
            studentCode: string;
            recordId: string;
            versionNo: number;
            gradePoints: number | string | null;
            outcome: Outcome;
            current: StoredGrade;
            attendance: StoredAttendance;
            marks: StoredMarks;
            revisions: StoredMarks;
          }[];
        }>('SELECT * FROM assessment.publication_view($1,$2)', [digest, offeringId])
        .catch(batchFailure)
    ).rows[0]!;
    const policy = loadPolicy(row.policy_id, row.policy_version);
    const results = row.results.map((stored): PilotPublishedResult => {
      const published = calculateResult(policy, calculatorInput(stored.marks, stored.attendance));
      const current = calculateResult(
        policy,
        calculatorInput({ ...stored.marks, ...stored.revisions }, stored.attendance),
      );
      const currentPoints = points(stored.current.gradePoints);
      return {
        enrolmentId: stored.enrolmentId,
        studentCode: stored.studentCode,
        recordId: stored.recordId,
        versionNo: stored.current.versionNo,
        publishedVersionNo: stored.versionNo,
        revisedAfterPvp: stored.current.versionNo !== stored.versionNo,
        ...present(current, currentPoints, stored.current.outcome),
        matches:
          reproduces(published, { ...stored, gradePoints: points(stored.gradePoints) }) &&
          reproduces(current, { ...stored.current, gradePoints: currentPoints }),
      };
    });
    const publication: PilotPublication = {
      publicationId: row.publication_id,
      offeringId,
      kind: row.kind,
      publisherSubject: row.publisher_subject,
      publishedAt: row.published_at,
      policy: { id: row.policy_id, version: row.policy_version },
      inputs: row.inputs,
      results,
      audit: {
        records: results.length,
        mismatches: results.filter((r) => !r.matches).map((r) => r.studentCode),
      },
    };
    response.json(publication);
  });

  router.get('/pilot/my-results', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    parse(noQuery, request.query);
    const { rows } = await sql()
      .query<{
        offering_id: string;
        course_code: string;
        section_code: string;
        term_code: string;
        kind: 'provisional' | 'final';
        published_at: string;
        policy_id: string;
        policy_version: number;
        record_id: string;
        published_version: number;
        version_no: number;
        grade_points: string | null;
        outcome: Outcome;
        attendance: StoredAttendance;
        marks: StoredMarks;
        revisions: StoredMarks;
      }>('SELECT * FROM assessment.my_results($1)', [digest])
      .catch(batchFailure);
    const results = rows.map((row): PilotStudentResult => {
      const policy = loadPolicy(row.policy_id, row.policy_version);
      const computed = calculateResult(
        policy,
        calculatorInput({ ...row.marks, ...row.revisions }, row.attendance),
      );
      return {
        offeringId: row.offering_id,
        recordId: row.record_id,
        courseCode: row.course_code,
        section: row.section_code,
        term: row.term_code,
        label: row.kind === 'final' ? 'Final' : 'Provisional',
        publishedAt: row.published_at,
        versionNo: row.version_no,
        revisedAfterPvp: row.version_no !== row.published_version,
        ...present(computed, points(row.grade_points), row.outcome),
      };
    });
    response.json({ results });
  });
}
