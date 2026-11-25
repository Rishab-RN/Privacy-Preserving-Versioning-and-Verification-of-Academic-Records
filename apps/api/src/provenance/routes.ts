import type { Router } from 'express';
import type { Driver } from 'neo4j-driver';
import { z } from 'zod';
import type { Platform } from '../platform.js';
import { ApiFailure, notFound } from '../errors.js';
import { parse, uuid } from '../inputs.js';
import { workflowFailure } from '../workflow.js';
import { review } from './graph.js';
import type { ProvenanceReview } from '@scholarproof/contracts';

const reviewQuery = z
  .object({
    recordId: uuid.optional(),
    version: z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .transform(Number)
      .pipe(z.number().int().max(2147483647))
      .optional(),
  })
  .strict()
  .refine((value) => (value.recordId === undefined) === (value.version === undefined));

export function installProvenanceRoutes(router: Router, platform: Platform, graph?: Driver) {
  router.get('/provenance/:institutionId', async (req, res) => {
    const { principal, digest } = await platform.authenticate(req.get('authorization'));
    const scope = parse(uuid, req.params.institutionId);
    if (
      !principal.roles.some(
        (role) =>
          role.institutionId === scope && (role.role === 'auditor' || role.role === 'registrar'),
      )
    )
      throw notFound();
    const { recordId, version } = parse(reviewQuery, req.query);
    const head = async () => {
      try {
        const { rows } = await platform.repository.sql.query<{ value: string }>(
          'SELECT provenance.review_head($1,$2) AS value',
          [digest, scope],
        );
        const value = Number(rows[0]?.value);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid SQL log size');
        return value;
      } catch (e) {
        workflowFailure(e);
      }
    };
    await head();
    if (!graph) throw new ApiFailure(503, 'GRAPH_UNAVAILABLE', 'Provenance service is unavailable');
    const to = new Date(),
      from = new Date(to.getTime() - 30 * 86400000);
    let result: Awaited<ReturnType<typeof review>>;
    try {
      result = await review(
        graph,
        scope,
        from,
        to,
        recordId !== undefined && version !== undefined ? { recordId, version } : undefined,
      );
    } catch {
      throw new ApiFailure(
        503,
        'GRAPH_UNAVAILABLE',
        'Provenance service did not return a usable result',
      );
    }
    // Recheck scope and the SQL high-water mark after the graph read.
    const committed = await head();
    const { head: graphHead, ...values } = result;
    if (graphHead.cursor > committed)
      throw new ApiFailure(
        503,
        'GRAPH_CURSOR_MISMATCH',
        'Graph cursor is ahead of the committed SQL journal',
      );
    const body: ProvenanceReview = {
      ...values,
      status: graphHead.cursor === committed ? 'current' : 'lagging',
      through: graphHead.cursor,
      committed,
      syncedAt: graphHead.syncedAt,
      from: from.toISOString(),
      to: to.toISOString(),
    };
    res.json(body);
  });
}
