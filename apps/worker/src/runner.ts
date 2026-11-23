import type { Pool } from 'pg';
import type { Db } from 'mongodb';
import { projectEvent, InvalidEventError, ProjectionConflictError } from './projection.js';

export type WorkerSql = Pick<Pool, 'query'>;
export interface ClaimedDelivery {
  event_id: string;
  lease_token: string;
  attempt: number;
  payload: unknown;
}
export async function runBatch(sql: WorkerSql, db: Db, shouldStop = () => false) {
  const claims = await sql.query<ClaimedDelivery>(
    'SELECT * FROM workflow.claim_deliveries($1,$2)',
    [5, 60],
  );
  const result = { claimed: claims.rowCount ?? 0, delivered: 0, failed: 0, stale: 0 };
  for (const delivery of claims.rows) {
    if (shouldStop()) break; // Unprocessed leases become claimable on expiry.
    try {
      await projectEvent(db, delivery.payload);
    } catch (error) {
      const code =
        error instanceof InvalidEventError
          ? 'INVALID_EVENT'
          : error instanceof ProjectionConflictError
            ? 'PROJECTION_CONFLICT'
            : 'MONGO_UNAVAILABLE';
      const failed = await sql.query<{ accepted: boolean }>(
        'SELECT workflow.fail_delivery($1,$2,$3) AS accepted',
        [delivery.event_id, delivery.lease_token, code],
      );
      if (failed.rows[0]?.accepted) result.failed++;
      else result.stale++;
      continue;
    }
    // An SQL acknowledgement failure is propagated, leaving the durable lease
    // to expire. It must not be reported as successful or as a Mongo failure.
    const ack = await sql.query<{ accepted: boolean }>(
      'SELECT workflow.ack_delivery($1,$2) AS accepted',
      [delivery.event_id, delivery.lease_token],
    );
    if (ack.rows[0]?.accepted) result.delivered++;
    else result.stale++;
  }
  return result;
}

export async function replayJournal(sql: WorkerSql, db: Db) {
  // A single SELECT gives one committed snapshot. Bound memory for this prototype;
  // larger research workloads need a cursor within a dedicated snapshot client.
  const events = await sql.query<{ payload: unknown }>(
    'SELECT payload FROM workflow.domain_event ORDER BY occurred_at,event_id LIMIT 10001',
  );
  if (events.rows.length > 10000) throw new Error('REPLAY_LIMIT');
  for (const event of events.rows) await projectEvent(db, event.payload);
  // Replay does not acknowledge a lease owned by a live worker. Normal delivery
  // confirms its own receipt later; duplicate immutable writes remain safe.
  return events.rows.length;
}
