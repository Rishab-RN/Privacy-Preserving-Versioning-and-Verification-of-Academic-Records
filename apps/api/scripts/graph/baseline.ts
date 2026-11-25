import type { ProvenanceReview } from '@scholarproof/contracts';
import type { Sql } from '../../src/repository.js';

const window =
  'FROM provenance.approved_fact WHERE institution_id=$1 AND occurred_at >= $2 AND occurred_at < $3';
const ids = '(array_agg(request_id ORDER BY occurred_at,request_id))[1:5] AS "requestIds"';
export const sqlWorkloads = {
  pairings: `SELECT proposer_id AS "proposerId",decider_id AS "approverId",count(*)::integer AS count,${ids}
    ${window} GROUP BY proposer_id,decider_id HAVING count(*)>=2 ORDER BY count DESC,proposer_id,decider_id LIMIT 20`,
  upward: `SELECT course_id AS "courseId",count(*)::integer AS count,
    sum(delta_hundredths)::integer AS "deltaHundredths",${ids}
    ${window} AND delta_hundredths>0 GROUP BY course_id ORDER BY count DESC,course_id LIMIT 20`,
  evidenceReuse: `SELECT digest,count(*)::integer AS count,${ids}
    ${window} GROUP BY digest HAVING count(*)>=2 ORDER BY count DESC,digest COLLATE "C" LIMIT 20`,
  ancestry: `WITH RECURSIVE scoped AS MATERIALIZED (
      SELECT * FROM provenance.approved_fact WHERE institution_id=$1 AND record_id=$2
    ), versions(version,depth) AS (
      SELECT $3::integer,0 WHERE EXISTS (
        SELECT 1 FROM scoped WHERE version_no IN ($3::bigint,$3::bigint+1))
      UNION ALL SELECT version-1,depth+1 FROM versions
      WHERE version>1 AND depth<20 AND EXISTS(SELECT 1 FROM scoped WHERE version_no=versions.version)
    )
    SELECT version,f.request_id AS "requestId",f.event_id AS "eventId",workflow.iso(f.occurred_at) AS "occurredAt",
      f.evidence_id AS "evidenceId",f.proposer_id AS "proposerId",f.decider_id AS "approverId"
    FROM versions LEFT JOIN scoped f ON f.version_no=versions.version ORDER BY version DESC`,
};

export async function reviewSql(
  sql: Sql,
  scope: string,
  from: Date,
  to: Date,
  recordId: string,
  version: number,
) {
  const args = [scope, from, to];
  return {
    pairings: (await sql.query<ProvenanceReview['pairings'][number]>(sqlWorkloads.pairings, args))
      .rows,
    upward: (await sql.query<ProvenanceReview['upward'][number]>(sqlWorkloads.upward, args)).rows,
    evidenceReuse: (
      await sql.query<ProvenanceReview['evidenceReuse'][number]>(sqlWorkloads.evidenceReuse, args)
    ).rows,
    ancestry: (
      await sql.query<ProvenanceReview['ancestry'][number]>(sqlWorkloads.ancestry, [
        scope,
        recordId,
        version,
      ])
    ).rows,
  };
}
