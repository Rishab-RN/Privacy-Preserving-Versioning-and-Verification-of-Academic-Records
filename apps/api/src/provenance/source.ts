import { z } from 'zod';
import type { Sql } from '../repository.js';

export const graphId = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
const count = z.number().int().nonnegative().safe();
const fact = z
  .object({
    event_id: graphId,
    occurred_at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
    request_id: graphId,
    proposer_id: graphId,
    decider_id: graphId,
    record_id: graphId,
    version_no: z.number().int().positive().max(2147483647),
    student_id: graphId,
    offering_id: graphId,
    course_id: graphId,
    evidence_id: graphId,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    delta_hundredths: z.number().int().min(-1000).max(1000).nullable(),
  })
  .strict();
export type ApprovedFact = z.infer<typeof fact> & { position: number };
const batch = z
  .object({
    size: count,
    slots: z
      .array(z.object({ position: count, accepted: z.boolean(), fact: fact.nullable() }).strict())
      .max(100),
  })
  .strict();

export async function readSource(sql: Sql, scope: string, cursor: number, limit = 100) {
  graphId.parse(scope);
  count.parse(cursor);
  const data = (
    await sql.query<{ value: unknown }>('SELECT provenance.source_batch($1,$2,$3) AS value', [
      scope,
      cursor,
      limit,
    ])
  ).rows[0]?.value;
  const result = batch.parse(data);
  if (
    cursor > result.size ||
    result.slots.length !== Math.min(limit, result.size - cursor) ||
    result.slots.some(
      (slot, i) => slot.position !== cursor + i || slot.accepted !== (slot.fact !== null),
    )
  )
    throw new Error('The committed provenance sequence is incomplete or out of order');
  return {
    size: result.size,
    next: cursor + result.slots.length,
    facts: result.slots.flatMap((s) => (s.fact ? [{ ...s.fact, position: s.position }] : [])),
  };
}

export function timestamp(date: Date) {
  return date.toISOString().replace(/(\.\d{3})Z$/, (_match, fraction: string) => fraction + '000Z');
}
