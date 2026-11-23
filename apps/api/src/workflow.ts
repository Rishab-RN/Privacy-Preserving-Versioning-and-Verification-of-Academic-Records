import type { Router } from 'express';
import type { ChangeProposalInput, ChangeRequestStatus } from '@scholarproof/contracts';
import { z } from 'zod';
import { ApiFailure, forbidden, notFound } from './errors.js';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';

const timestamp = z.iso.datetime({ offset: true }).refine((value) => !/\.\d{7,}/.test(value));
const reason = z
  .string()
  .min(1)
  .refine((value) => Array.from(value).length <= 500)
  .refine((value) => value.trim().length > 0);
const proposal = z
  .object({
    expectedVersion: z.number().int().min(0).max(2147483646),
    gradePoints: z
      .string()
      .regex(/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/)
      .nullable(),
    outcome: z.enum(['passed', 'failed', 'withdrawn', 'incomplete']),
    validFrom: timestamp,
    validUntil: timestamp.nullable(),
    evidenceId: uuid,
    reason,
  })
  .strict() satisfies z.ZodType<ChangeProposalInput>;
const decision = z.object({ reason }).strict();

export function workflowFailure(error: unknown): never {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === '28000') throw new ApiFailure(401, 'UNAUTHORIZED', 'Authentication required');
  if (code === '42501')
    throw new ApiFailure(403, 'FORBIDDEN', 'This actor cannot perform this transition');
  if (code === 'P0002' || code === '23503')
    throw new ApiFailure(404, 'NOT_FOUND', 'Resource not found');
  if (code === '40001')
    throw new ApiFailure(409, 'VERSION_CONFLICT', 'The record changed; review its latest revision');
  if (code === '23505')
    throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'The key was used for a different change');
  if (code === '55000')
    throw new ApiFailure(409, 'DECISION_CONFLICT', 'This request already has a different decision');
  if (
    code === '22023' ||
    code === '23514' ||
    code === '22003' ||
    code === '22007' ||
    code === '22008'
  )
    throw new ApiFailure(
      400,
      'INVALID_CHANGE',
      'The proposed change does not satisfy its academic or evidence policy',
    );
  throw error;
}

export function installWorkflowRoutes(router: Router, platform: Platform) {
  router.get('/records/:recordId/change-context', async (request, response) => {
    const { principal } = await platform.authenticate(request.get('authorization'));
    const recordId = parse(uuid, request.params.recordId);
    if (!principal.roles.some(({ role }) => role === 'registrar')) throw forbidden();
    const record = await platform.repository.record(principal.userId, recordId, true);
    if (!record) throw notFound();
    // Advisory preparation only: SQL checks the expected version again when
    // proposing and applying a change, including concurrent corrections.
    response.json({ recordId, latestRecordedVersion: record.latest_recorded_version });
  });
  const status = async (digest: string, requestId: string) => {
    const result = await platform.repository.sql.query<{ value: ChangeRequestStatus }>(
      'SELECT workflow.get_change($1,$2) AS value',
      [digest, requestId],
    );
    return result.rows[0]!.value;
  };
  router.post('/records/:recordId/change-requests', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const recordId = parse(uuid, request.params.recordId);
    const key = parse(uuid, request.get('idempotency-key'));
    const input = parse(proposal, request.body);
    try {
      const result = await platform.repository.sql.query<{ id: string }>(
        'SELECT workflow.propose_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
        [
          digest,
          recordId,
          key,
          input.expectedVersion,
          input.gradePoints,
          input.outcome,
          input.validFrom,
          input.validUntil,
          input.evidenceId,
          input.reason,
        ],
      );
      response.status(201).json(await status(digest, result.rows[0]!.id));
    } catch (error) {
      workflowFailure(error);
    }
  });
  router.get('/change-requests/:requestId', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const id = parse(uuid, request.params.requestId);
    try {
      response.json(await status(digest, id));
    } catch (error) {
      workflowFailure(error);
    }
  });
  router.post('/change-requests/:requestId/approve', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const id = parse(uuid, request.params.requestId);
    const input = parse(decision, request.body);
    try {
      await platform.repository.sql.query('SELECT workflow.approve_change($1,$2,$3)', [
        digest,
        id,
        input.reason,
      ]);
      // 202 confirms the SQL transition. It does not claim delivered projections
      // or a signed credential, which are separate durable stages.
      response.status(202).json(await status(digest, id));
    } catch (error) {
      workflowFailure(error);
    }
  });
  router.post('/change-requests/:requestId/reject', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const id = parse(uuid, request.params.requestId);
    const input = parse(decision, request.body);
    try {
      await platform.repository.sql.query('SELECT workflow.reject_change($1,$2,$3)', [
        digest,
        id,
        input.reason,
      ]);
      response.json(await status(digest, id));
    } catch (error) {
      workflowFailure(error);
    }
  });
}
