import { createHash } from 'node:crypto';
import type { Router } from 'express';
import { AssessmentError, getPolicy, validateStageMarks } from '@academic-records/assessment';
import type { AssessmentPolicy, Part } from '@academic-records/assessment';
import type {
  PilotBatch,
  PilotBatchCreated,
  PilotBatchStage,
  PilotBatchSubmission,
  PilotBatchSummary,
} from '@scholarproof/contracts';
import { z } from 'zod';
import { ApiFailure } from './errors.js';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';
import { workflowFailure } from './workflow.js';

const MAX_ROWS = 999;
const stage = z.enum(['cie', 'see']);
const batchInput = z
  .object({
    stage,
    expectedRevision: z.number().int().min(0).max(1_000_000),
    components: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/))
      .min(1)
      .max(40),
    rows: z
      .array(
        z
          .object({
            enrolmentId: uuid,
            values: z.array(z.string().max(8)).min(1).max(40),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROWS),
  })
  .strict();
type BatchInput = z.infer<typeof batchInput>;

/** Maps batch-specific SQL states, then defers to the shared workflow mapping. */
function batchFailure(error: unknown): never {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === '40001') {
    throw new ApiFailure(409, 'STALE_REVISION', 'A newer revision exists; reload the latest one');
  }
  if (code === '55000') {
    throw new ApiFailure(
      409,
      'BATCH_UNDER_REVIEW',
      'The latest revision is submitted and awaits review',
    );
  }
  if (code === '22P02')
    throw new ApiFailure(400, 'INVALID_BATCH', 'The batch has malformed values');
  return workflowFailure(error);
}

const invalid = (code: string, message: string) => new ApiFailure(422, code, message);

function stageComponents(policy: AssessmentPolicy, part: Part): string[] {
  return policy.groups
    .filter((group) => group.part === part)
    .flatMap((group) => group.components.filter((c) => !c.optional).map((c) => c.code));
}

/**
 * Checks a revision against the offering's policy and roster before it reaches SQL: known
 * components for the stage, valid values for every row, no duplicate or foreign enrolments, and
 * (for CIE) every enrolled student. SEE batches may cover a subset, since eligibility is decided
 * by the approved CIE.
 */
function validate(policy: AssessmentPolicy, input: BatchInput, roster: ReadonlySet<string>) {
  if (new Set(input.components).size !== input.components.length) {
    throw invalid('DUPLICATE_COMPONENT', 'Each component may appear once');
  }
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (seen.has(row.enrolmentId)) {
      throw invalid('DUPLICATE_ENROLMENT', `${row.enrolmentId} appears more than once`);
    }
    seen.add(row.enrolmentId);
    if (!roster.has(row.enrolmentId)) {
      throw invalid('UNKNOWN_ENROLMENT', `${row.enrolmentId} is not enrolled in this offering`);
    }
    if (row.values.length !== input.components.length) {
      throw invalid('ROW_LENGTH', 'Each row needs one value per component');
    }
    const marks = Object.fromEntries(input.components.map((code, i) => [code, row.values[i]!]));
    try {
      validateStageMarks(policy, input.stage, marks);
    } catch (error) {
      if (error instanceof AssessmentError) {
        throw invalid(error.code, `${row.enrolmentId}: ${error.message}`);
      }
      throw error;
    }
  }
  if (input.stage === 'cie' && seen.size !== roster.size) {
    throw invalid('INCOMPLETE_ROSTER', 'A CIE batch must include every enrolled student');
  }
}

/** SHA-256 over rows sorted by enrolment and component, with values as two-decimal text. */
function contentDigest(input: BatchInput): string {
  const lines = input.rows
    .flatMap((row) =>
      input.components.map((code, i) => {
        const value = row.values[i]!;
        return `${row.enrolmentId}\t${code}\t${value === 'AB' ? 'AB' : Number(value).toFixed(2)}`;
      }),
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function installAssessmentBatchRoutes(router: Router, platform: Platform) {
  const sql = () => platform.repository.sql;

  async function rosterOf(digest: string, offeringId: string): Promise<Set<string>> {
    const roster = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page: { rows: { enrolment_id: string }[] } = await sql()
        .query<{ enrolment_id: string }>('SELECT enrolment_id FROM pilot.read_roster($1,$2,$3)', [
          digest,
          offeringId,
          after,
        ])
        .catch(batchFailure);
      for (const row of page.rows.slice(0, 100)) roster.add(row.enrolment_id);
      if (page.rows.length <= 100) return roster;
      after = page.rows[99]!.enrolment_id;
    }
  }

  router.get('/pilot/offerings/:offeringId/batches', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const offeringId = parse(uuid, request.params.offeringId);
    const { rows } = await sql()
      .query<PilotBatchSummary>(
        `SELECT batch_id AS "batchId", stage, revision_no AS "revisionNo",
           author_subject AS "authorSubject", created_at AS "createdAt", submitted_at AS "submittedAt"
         FROM assessment.list_batches($1,$2)`,
        [digest, offeringId],
      )
      .catch(batchFailure);
    response.json({ batches: rows });
  });

  router.post('/pilot/offerings/:offeringId/batches', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const offeringId = parse(uuid, request.params.offeringId);
    const key = parse(uuid, request.get('idempotency-key'));
    const input = parse(batchInput, request.body);
    const context = (
      await sql()
        .query<{ policy_id: string; policy_version: number }>(
          'SELECT policy_id,policy_version FROM assessment.entry_context($1,$2,$3)',
          [digest, offeringId, input.stage],
        )
        .catch(batchFailure)
    ).rows[0]!;
    let policy: AssessmentPolicy;
    try {
      policy = getPolicy(context.policy_id);
    } catch {
      throw new ApiFailure(409, 'POLICY_UNAVAILABLE', 'The offering policy is not installed');
    }
    if (policy.version !== context.policy_version) {
      throw new ApiFailure(
        409,
        'POLICY_UNAVAILABLE',
        'The offering policy version is not installed',
      );
    }
    validate(policy, input, await rosterOf(digest, offeringId));
    const marks = input.rows.flatMap((row) =>
      input.components.map((component, i) => ({
        enrolmentId: row.enrolmentId,
        component,
        points: row.values[i] === 'AB' ? null : row.values[i],
      })),
    );
    const created = (
      await sql()
        .query<{ batch_id: string; revision_no: number; created: boolean }>(
          'SELECT batch_id,revision_no,created FROM assessment.create_revision($1,$2,$3,$4,$5,$6)',
          [digest, offeringId, input.stage, input.expectedRevision, key, JSON.stringify(marks)],
        )
        .catch(batchFailure)
    ).rows[0]!;
    const result: PilotBatchCreated = {
      batchId: created.batch_id,
      offeringId,
      stage: input.stage,
      revisionNo: created.revision_no,
      created: created.created,
      contentDigest: contentDigest(input),
    };
    response.status(created.created ? 201 : 200).json(result);
  });

  router.get('/pilot/batches/:batchId', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const batchId = parse(uuid, request.params.batchId);
    const row = (
      await sql()
        .query<{
          offering_id: string;
          stage: PilotBatchStage;
          revision_no: number;
          author_subject: string;
          created_at: string;
          submitted_at: string | null;
          policy_id: string;
          policy_version: number;
          marks: {
            enrolmentId: string;
            studentCode: string;
            component: string;
            points: string | number | null;
          }[];
        }>('SELECT * FROM assessment.read_batch($1,$2)', [digest, batchId])
        .catch(batchFailure)
    ).rows[0]!;
    const policy = getPolicy(row.policy_id);
    const known = stageComponents(policy, row.stage);
    const present = new Set(row.marks.map((mark) => mark.component));
    const components = known.filter((code) => present.has(code));
    const rows = new Map<string, PilotBatch['rows'][number]>();
    for (const mark of row.marks) {
      const entry = rows.get(mark.enrolmentId) ?? {
        enrolmentId: mark.enrolmentId,
        studentCode: mark.studentCode,
        values: components.map(() => ''),
      };
      entry.values[components.indexOf(mark.component)] =
        mark.points === null ? 'AB' : Number(mark.points).toFixed(2);
      rows.set(mark.enrolmentId, entry);
    }
    const batch: PilotBatch = {
      batchId,
      offeringId: row.offering_id,
      stage: row.stage,
      revisionNo: row.revision_no,
      authorSubject: row.author_subject,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      policy: { id: row.policy_id, version: row.policy_version },
      components,
      rows: [...rows.values()],
    };
    response.json(batch);
  });

  router.post('/pilot/batches/:batchId/submit', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const batchId = parse(uuid, request.params.batchId);
    const row = (
      await sql()
        .query<{ submitted_at: string; created: boolean }>(
          'SELECT submitted_at,created FROM assessment.submit_batch($1,$2)',
          [digest, batchId],
        )
        .catch(batchFailure)
    ).rows[0]!;
    const result: PilotBatchSubmission = {
      batchId,
      submittedAt: row.submitted_at,
      alreadySubmitted: !row.created,
    };
    response.json(result);
  });
}
