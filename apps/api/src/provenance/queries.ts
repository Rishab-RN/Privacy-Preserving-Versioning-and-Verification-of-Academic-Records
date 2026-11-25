// Static Cypher queries. No identifiers or clauses are derived from request input.
export const upsertFacts = `
UNWIND $facts AS f
MERGE (i:Prov:Institution {key:$scope}) ON CREATE SET i.scope=$scope
MERGE (s:Prov:Student {key:$scope+':'+f.student_id}) ON CREATE SET s.scope=$scope, s.id=f.student_id
MERGE (c:Prov:Course {key:$scope+':'+f.course_id}) ON CREATE SET c.scope=$scope, c.id=f.course_id
MERGE (o:Prov:Offering {key:$scope+':'+f.offering_id}) ON CREATE SET o.scope=$scope, o.id=f.offering_id
MERGE (r:Prov:GradeRecord {key:$scope+':'+f.record_id}) ON CREATE SET r.scope=$scope, r.id=f.record_id
MERGE (v:Prov:GradeVersion {key:$scope+':'+f.record_id+':'+toString(toInteger(f.version_no))})
ON CREATE SET v.scope=$scope, v.version=toInteger(f.version_no)
MERGE (q:Prov:Correction {key:$scope+':'+f.request_id})
ON CREATE SET q.scope=$scope,q.id=f.request_id,q.eventId=f.event_id,q.occurredAt=f.occurred_at,
  q.delta=toInteger(f.delta_hundredths),q.position=toInteger(f.position)
MERGE (a:Prov:Actor {key:$scope+':'+f.proposer_id}) ON CREATE SET a.scope=$scope, a.id=f.proposer_id
MERGE (b:Prov:Actor {key:$scope+':'+f.decider_id}) ON CREATE SET b.scope=$scope, b.id=f.decider_id
MERGE (e:Prov:Evidence {key:$scope+':'+f.evidence_id}) ON CREATE SET e.scope=$scope,e.id=f.evidence_id
MERGE (d:Prov:EvidenceDigest {key:$scope+':'+f.digest}) ON CREATE SET d.scope=$scope,d.digest=f.digest
MERGE (i)-[:HAS_STUDENT]->(s)
MERGE (i)-[:HAS_COURSE]->(c)
MERGE (o)-[:INSTANCE_OF]->(c)
MERGE (r)-[:FOR_OFFERING]->(o)
MERGE (s)-[:HAS_RECORD]->(r)
MERGE (r)-[:HAS_VERSION]->(v)
MERGE (q)-[:RESULTED_IN]->(v)
MERGE (q)-[:PROPOSED_BY]->(a)
MERGE (q)-[:APPROVED_BY]->(b)
MERGE (q)-[:USES_EVIDENCE]->(e)
MERGE (e)-[:HAS_DIGEST]->(d)
FOREACH (_ IN CASE WHEN f.version_no > 1 THEN [1] ELSE [] END |
  MERGE (previous:Prov:GradeVersion {key:$scope+':'+f.record_id+':'+toString(toInteger(f.version_no)-1)})
  ON CREATE SET previous.scope=$scope, previous.version=toInteger(f.version_no)-1
  MERGE (r)-[:HAS_VERSION]->(previous)
  MERGE (v)-[:PREVIOUS]->(previous)
)
`;

export const ancestry = `
MATCH (r:GradeRecord {key:$scope+':'+$recordId})-[:HAS_VERSION]->(v:GradeVersion {version:toInteger($version)})
MATCH path=(v)-[:PREVIOUS*0..20]->(a:GradeVersion)
WHERE all(node IN nodes(path) WHERE node.scope=$scope)
OPTIONAL MATCH (a)<-[:RESULTED_IN]-(q:Correction {scope:$scope})-[:USES_EVIDENCE]->(e:Evidence {scope:$scope})
OPTIONAL MATCH (q)-[:PROPOSED_BY]->(p:Actor {scope:$scope})
OPTIONAL MATCH (q)-[:APPROVED_BY]->(d:Actor {scope:$scope})
RETURN a.version AS version,q.id AS requestId,q.eventId AS eventId,q.occurredAt AS occurredAt,
       e.id AS evidenceId,p.id AS proposerId,d.id AS approverId
ORDER BY version DESC LIMIT 21
`;

const window = `MATCH (q:Correction {scope:$scope})
WHERE q.occurredAt >= $from AND q.occurredAt < $to`;
export const pairings = `${window}
MATCH (q)-[:PROPOSED_BY]->(a:Actor {scope:$scope})
MATCH (q)-[:APPROVED_BY]->(b:Actor {scope:$scope})
WITH a,b,q ORDER BY q.occurredAt,q.id
WITH a.id AS proposerId,b.id AS approverId,count(q) AS count,collect(q.id)[0..5] AS requestIds
WHERE count >= 2
RETURN proposerId,approverId,count,requestIds ORDER BY count DESC,proposerId,approverId LIMIT 20`;

export const upward = `${window} AND q.delta>0
MATCH (q)-[:RESULTED_IN]->(:GradeVersion {scope:$scope})<-[:HAS_VERSION]-(:GradeRecord {scope:$scope})
       -[:FOR_OFFERING]->(:Offering {scope:$scope})-[:INSTANCE_OF]->(c:Course {scope:$scope})
WITH c,q ORDER BY q.occurredAt,q.id
RETURN c.id AS courseId,count(q) AS count,sum(q.delta) AS deltaHundredths,collect(q.id)[0..5] AS requestIds
ORDER BY count DESC,courseId LIMIT 20`;

export const evidenceReuse = `${window}
MATCH (q)-[:USES_EVIDENCE]->(:Evidence {scope:$scope})-[:HAS_DIGEST]->(h:EvidenceDigest {scope:$scope})
WITH h,q ORDER BY q.occurredAt,q.id
WITH h.digest AS digest,count(q) AS count,collect(q.id)[0..5] AS requestIds WHERE count >= 2
RETURN digest,count,requestIds ORDER BY count DESC,digest LIMIT 20`;

// Both time and commit order are exclusive. A late commit with an earlier
// timestamp must not appear in the feature history of an already logged event.
export const features = `
MATCH (target:Correction {key:$scope+':'+$requestId})-[:PROPOSED_BY]->(a:Actor {scope:$scope})
MATCH (target)-[:APPROVED_BY]->(b:Actor {scope:$scope})
MATCH (target)-[:USES_EVIDENCE]->(:Evidence {scope:$scope})-[:HAS_DIGEST]->(h:EvidenceDigest {scope:$scope})
CALL (target,a,b) {
  OPTIONAL MATCH (a)<-[:PROPOSED_BY]-(past:Correction {scope:$scope})-[:APPROVED_BY]->(b)
  WHERE past.occurredAt >= $from AND past.occurredAt < target.occurredAt AND past.position < target.position
  RETURN count(past) AS priorPairCount
}
CALL (target,h) {
  OPTIONAL MATCH (h)<-[:HAS_DIGEST]-(:Evidence {scope:$scope})<-[:USES_EVIDENCE]-(past:Correction {scope:$scope})
  WHERE past.occurredAt >= $from AND past.occurredAt < target.occurredAt AND past.position < target.position
  RETURN count(past) AS priorEvidenceCount
}
RETURN target.id AS requestId,target.occurredAt AS eventTime,priorPairCount,priorEvidenceCount
`;
