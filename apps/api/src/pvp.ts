import type { Router } from 'express';
import {
  AssessmentError,
  calculateResult,
  resolvePaperViewing,
} from '@academic-records/assessment';
import type { PaperViewingResolution } from '@academic-records/assessment';
import type { ChangeRequestStatus, PilotPvpProposal } from '@scholarproof/contracts';
import { z } from 'zod';
import { batchFailure } from './assessment-batches.js';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';
import { calculatorInput, invalid, loadPolicy, storedForm } from './publication.js';
import type { StoredAttendance, StoredMarks } from './publication.js';

const pvpInput = z
  .object({
    expectedVersion: z.number().int().min(1).max(2147483646),
    revised: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/))
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Paper Viewing Process corrections (R12). A registrar submits the expert team's revalued SEE
 * theory marks; the better of the two marks is kept, lab examinations are excluded and no mark
 * may go down. The recomputed grade is proposed through the existing correction workflow with
 * the revaluation as evidence, and a different registrar approves it into a new version.
 */
export function installPvpRoutes(router: Router, platform: Platform) {
  const sql = () => platform.repository.sql;

  router.post('/pilot/records/:recordId/pvp', async (request, response) => {
    const { principal, digest } = await platform.authenticate(request.get('authorization'));
    const recordId = parse(uuid, request.params.recordId);
    const key = parse(uuid, request.get('idempotency-key'));
    const input = parse(pvpInput, request.body);
    const context = (
      await sql()
        .query<{
          policy_id: string;
          policy_version: number;
          attendance: StoredAttendance;
          marks: StoredMarks;
          revisions: StoredMarks;
        }>('SELECT * FROM assessment.pvp_context($1,$2)', [digest, recordId])
        .catch(batchFailure)
    ).rows[0]!;
    const policy = loadPolicy(context.policy_id, context.policy_version);
    const current = calculatorInput({ ...context.marks, ...context.revisions }, context.attendance);
    let resolution: PaperViewingResolution;
    try {
      resolution = resolvePaperViewing(policy, current.marks, input.revised);
    } catch (error) {
      if (error instanceof AssessmentError) throw invalid(error.code, error.message);
      throw error;
    }
    if (resolution.ignoredDecreases.length > 0) {
      throw invalid(
        'NO_NEGATIVE_EVALUATION',
        `${resolution.ignoredDecreases.join(', ')} would go down; the better of the two marks stands`,
      );
    }
    if (!resolution.changed) throw invalid('NO_CHANGE', 'The revaluation raises no mark');
    const revised = calculateResult(policy, {
      attendance: current.attendance,
      marks: resolution.marks,
    });
    const grade = storedForm(revised);
    const letter = revised.letter;
    const increased = [...resolution.increased];
    const evidence = await platform.upload(principal, recordId, key, {
      schemaVersion: 1,
      category: 'revaluation_request',
      data: {
        process: 'paper_viewing',
        policyId: policy.id,
        policyVersion: policy.version,
        components: increased,
        original: increased.map((code) => current.marks[code]!),
        revised: increased.map((code) => input.revised[code]!),
      },
    });
    const requestId = (
      await sql()
        .query<{ id: string }>('SELECT assessment.propose_pvp($1,$2,$3,$4,$5,$6,$7,$8,$9) AS id', [
          digest,
          recordId,
          key,
          input.expectedVersion,
          evidence.evidenceId,
          JSON.stringify(Object.fromEntries(increased.map((code) => [code, input.revised[code]]))),
          grade.gradePoints === null ? null : grade.gradePoints.toFixed(2),
          grade.outcome,
          input.reason,
        ])
        .catch(batchFailure)
    ).rows[0]!.id;
    const status = (
      await sql()
        .query<{ value: ChangeRequestStatus }>('SELECT workflow.get_change($1,$2) AS value', [
          digest,
          requestId,
        ])
        .catch(batchFailure)
    ).rows[0]!.value;
    const result: PilotPvpProposal = {
      request: status,
      evidenceId: evidence.evidenceId,
      increased,
      result: { letter, gradePoints: grade.gradePoints, outcome: grade.outcome },
    };
    response.status(201).json(result);
  });
}
